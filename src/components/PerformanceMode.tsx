import { Fragment, useEffect, useRef, useState } from 'react'
import { Download, Pause, Play, Square, Volume2, X } from 'lucide-react'
import { tokenizeScriptLine } from '../utils/scriptLineTokens'
import { audioFilename } from '../utils/scriptExport'
import { downloadBlob } from '../utils/downloadFile'
import { ScriptSpeaker, buildSpeechPlan, isSpeechSynthesisSupported } from '../services/speech'
import {
  BrowserSpeechEngine,
  OpenRouterSpeechEngine,
  fetchUtteranceAudio,
  type SpeechEngine,
} from '../services/speechEngines'
import {
  countUtterances,
  createSpeechDecoder,
  isSpeechExportCancelled,
  isSpeechExportSupported,
  renderSpeechExport,
} from '../services/speechExport'
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  TTS_MODELS,
  defaultVoiceForModel,
  findTtsModel,
} from '../services/openrouterTts'
import {
  getOpenRouterApiKey,
  getReadAloudEngine,
  getReadAloudVoice,
  getTtsModel,
  setReadAloudEngine,
  setReadAloudVoice,
  setTtsModel,
  type ReadAloudEngine,
} from '../services/config'

interface PerformanceSection {
  title: string
  content: string
}

interface PerformanceModeProps {
  title?: string
  sections: PerformanceSection[]
  showSectionTitles: boolean
  onExit: () => void
}

const MIN_SPEED = 10
const MAX_SPEED = 120
const DEFAULT_SPEED = 40

const SPEECH_RATES = [0.5, 0.75, 1, 1.25, 1.5]

type SpeechStatus = 'idle' | 'playing' | 'paused'

type ExportStatus =
  | { phase: 'idle' }
  | { phase: 'rendering'; completed: number; total: number }

// Full-screen read-aloud view (stories 4.2, 4.4, 4.5 and 4.6): larger reading
// text, pacing marks and stage directions muted, optional auto-scroll with
// adjustable speed, read-aloud through either browser speech synthesis or an
// OpenRouter text-to-speech model, and export of that same read as one paced
// recording. Rendered as a modal <dialog>, so Escape and focus containment
// come from the platform; refs exist only for the imperative dialog, scroll
// and speech APIs.
export const PerformanceMode = ({ title, sections, showSectionTitles, onExit }: PerformanceModeProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isScrolling, setIsScrolling] = useState(false)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)

  const speechSupported = isSpeechSynthesisSupported()
  // Read once: the settings modal cannot be opened from behind this dialog, so
  // the key cannot change while the view is up.
  const [openRouterApiKey] = useState(getOpenRouterApiKey)
  // The speaker is a handle onto the imperative audio APIs, kept in a ref for
  // the same reason as the dialog element.
  const speakerRef = useRef<ScriptSpeaker | null>(null)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>('idle')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [speechRate, setSpeechRate] = useState(1)
  const [spokenParagraphKey, setSpokenParagraphKey] = useState<string | null>(null)
  const [speechError, setSpeechError] = useState<string | null>(null)

  // The paid engine is only offered with a key to spend against, and is the
  // only option on a platform without speech synthesis.
  const openRouterAvailable = !!openRouterApiKey
  const [engine, setEngine] = useState<ReadAloudEngine>(() => {
    const stored = getReadAloudEngine()
    if (stored === 'openrouter' && openRouterAvailable) return 'openrouter'
    if (!speechSupported && openRouterAvailable) return 'openrouter'
    return 'browser'
  })
  const [voiceURI, setVoiceURI] = useState(() => getReadAloudVoice('browser', ''))
  const [ttsModel, setTtsModelState] = useState(() => getTtsModel(DEFAULT_TTS_MODEL))
  const [ttsVoice, setTtsVoice] = useState(() => getReadAloudVoice('openrouter', DEFAULT_TTS_VOICE))

  // Export renders the hosted voice into a file, so it is offered wherever
  // that voice is: browser speech synthesis gives no audio to capture.
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ phase: 'idle' })
  const exportControllerRef = useRef<AbortController | null>(null)

  const readAloudAvailable = speechSupported || openRouterAvailable
  const usingOpenRouter = engine === 'openrouter' && openRouterAvailable
  const ttsModelVoices = findTtsModel(ttsModel)?.voices
  const exportAvailable = openRouterAvailable && isSpeechExportSupported()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return
    dialog.showModal()
    return () => dialog.close()
  }, [])

  // Voice lists load asynchronously in some browsers, so listen for changes.
  useEffect(() => {
    if (!speechSupported) return
    const synth = window.speechSynthesis
    const loadVoices = () => setVoices(synth.getVoices())
    loadVoices()
    synth.addEventListener('voiceschanged', loadVoices)
    return () => synth.removeEventListener('voiceschanged', loadVoices)
  }, [speechSupported])

  // Cancel any in-flight speech when the dialog unmounts (exit or Escape).
  // The speaker stops its engine, which cancels queued utterances and aborts
  // any request still in flight.
  useEffect(() => {
    return () => {
      speakerRef.current?.stop()
      speakerRef.current = null
      // An export left running would go on paying for utterances nobody is
      // waiting for, so it leaves with the view too.
      exportControllerRef.current?.abort()
      exportControllerRef.current = null
    }
  }, [])

  // Drive the auto-scroll. With reduced motion preferred, the glide is
  // replaced by one discrete step per second instead of per-frame movement.
  useEffect(() => {
    if (!isScrolling) return
    const container = scrollRef.current
    if (!container) return

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (prefersReducedMotion) {
      const intervalId = window.setInterval(() => {
        container.scrollTop += speed
      }, 1000)
      return () => window.clearInterval(intervalId)
    }

    let frameId = 0
    let lastTime = performance.now()
    let carry = 0

    const step = (now: number) => {
      const elapsedSeconds = (now - lastTime) / 1000
      lastTime = now
      carry += speed * elapsedSeconds
      const wholePixels = Math.floor(carry)
      if (wholePixels > 0) {
        container.scrollTop += wholePixels
        carry -= wholePixels
      }
      frameId = requestAnimationFrame(step)
    }

    frameId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameId)
  }, [isScrolling, speed])

  const stopReadAloud = () => {
    speakerRef.current?.stop()
    speakerRef.current = null
    setSpeechStatus('idle')
    setSpokenParagraphKey(null)
  }

  const createEngine = (): SpeechEngine =>
    usingOpenRouter
      ? new OpenRouterSpeechEngine({ apiKey: openRouterApiKey!, model: ttsModel, voice: ttsVoice })
      : new BrowserSpeechEngine(voiceURI)

  const toggleReadAloud = () => {
    if (speechStatus === 'playing') {
      speakerRef.current?.pause()
      setSpeechStatus('paused')
      return
    }
    if (speechStatus === 'paused') {
      speakerRef.current?.resume()
      setSpeechStatus('playing')
      return
    }
    // Starting fresh: the spoken position takes over from constant scrolling.
    setIsScrolling(false)
    setSpeechError(null)
    const speaker = new ScriptSpeaker(
      buildSpeechPlan(sections),
      createEngine(),
      { rate: speechRate },
      {
        onParagraphSpoken: setSpokenParagraphKey,
        onFinished: () => {
          speakerRef.current = null
          setSpeechStatus('idle')
          setSpokenParagraphKey(null)
        },
        onFailed: (message) => {
          speakerRef.current = null
          setSpeechStatus('idle')
          setSpokenParagraphKey(null)
          setSpeechError(message)
        },
      }
    )
    speakerRef.current = speaker
    setSpeechStatus('playing')
    speaker.start()
  }

  // Renders the whole script — the same utterances and the same silences
  // read-aloud would produce — into one file. Lines already heard come from
  // the cache, so exporting a script that has been played through costs
  // nothing; a long unheard script is a run of billed requests, which is why
  // progress is shown and the button becomes a cancel while it runs.
  const handleExport = async () => {
    if (exportStatus.phase === 'rendering') {
      exportControllerRef.current?.abort()
      return
    }

    const plan = buildSpeechPlan(sections)
    const total = countUtterances(plan)
    if (total === 0) return

    stopReadAloud()
    setSpeechError(null)
    const controller = new AbortController()
    exportControllerRef.current = controller
    setExportStatus({ phase: 'rendering', completed: 0, total })

    try {
      const recording = await renderSpeechExport({
        plan,
        rate: speechRate,
        synthesize: (text) =>
          fetchUtteranceAudio({
            apiKey: openRouterApiKey!,
            model: ttsModel,
            voice: ttsVoice,
            text,
            signal: controller.signal,
          }),
        decode: createSpeechDecoder(),
        signal: controller.signal,
        onProgress: ({ completed }) => setExportStatus({ phase: 'rendering', completed, total }),
      })
      downloadBlob(recording, audioFilename(title ?? ''))
    } catch (error) {
      // A cancelled export is what the user asked for, so it says nothing.
      if (!isSpeechExportCancelled(error)) {
        setSpeechError(
          error instanceof Error ? error.message : 'The recording could not be produced'
        )
      }
    } finally {
      exportControllerRef.current = null
      setExportStatus({ phase: 'idle' })
    }
  }

  // Engine and model changes swap out the voice entirely, so an in-progress
  // read stops rather than switching timbre mid-sentence, and a recording
  // being rendered is abandoned rather than finished in a voice no longer
  // chosen. A voice change within one engine applies from the next utterance.
  const handleEngineChanged = (next: ReadAloudEngine) => {
    stopReadAloud()
    exportControllerRef.current?.abort()
    setSpeechError(null)
    setEngine(next)
    setReadAloudEngine(next)
  }

  const handleModelChanged = (model: string) => {
    stopReadAloud()
    exportControllerRef.current?.abort()
    setSpeechError(null)
    setTtsModelState(model)
    setTtsModel(model)
    const voices = findTtsModel(model)?.voices
    if (!voices || !voices.includes(ttsVoice)) {
      const voice = defaultVoiceForModel(model)
      setTtsVoice(voice)
      setReadAloudVoice('openrouter', voice)
    }
  }

  const handleVoiceChanged = (voice: string) => {
    if (usingOpenRouter) {
      setTtsVoice(voice)
      setReadAloudVoice('openrouter', voice)
    } else {
      setVoiceURI(voice)
      setReadAloudVoice('browser', voice)
    }
    speakerRef.current?.setVoice(voice)
  }

  const handleRateChanged = (rate: number) => {
    setSpeechRate(rate)
    speakerRef.current?.setRate(rate)
  }

  // Ref callback attached only to the paragraph currently being spoken, so
  // the reading surface follows the voice. Same legitimacy as the scroll
  // machinery above: imperative scrolling of the existing container.
  const followSpokenParagraph = (element: HTMLParagraphElement | null) => {
    if (!element) return
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    })
  }

  const renderLines = (content: string, sectionIndex: number) =>
    content
      .split('\n')
      .map((line, lineIndex) => ({ line, key: `line-${sectionIndex}-${lineIndex}` }))
      .filter(({ line }) => line.trim() && !line.startsWith('## '))
      .map(({ line, key }) => {
        const isSpoken = key === spokenParagraphKey
        return (
          <p
            key={key}
            data-spoken={isSpoken || undefined}
            ref={isSpoken ? followSpokenParagraph : undefined}
          >
            {tokenizeScriptLine(line).map((token, tokenIndex) =>
              token.kind === 'text' ? (
                <Fragment key={tokenIndex}>{token.text}</Fragment>
              ) : (
                <span
                  key={tokenIndex}
                  className={token.kind === 'direction' ? 'stage-direction' : 'pacing-mark'}
                >
                  {token.text}
                </span>
              )
            )}
          </p>
        )
      })

  return (
    <dialog
      ref={dialogRef}
      className="performance-mode"
      aria-label="Performance mode"
      onCancel={onExit}
    >
      <div
        className="performance-scroll"
        ref={scrollRef}
        tabIndex={0}
        aria-label="Script text"
      >
        <article>
          {title && <h2>{title}</h2>}
          {sections.map((section, sectionIndex) => (
            <section key={`performance-section-${sectionIndex}`}>
              {showSectionTitles && <h3>{section.title}</h3>}
              {renderLines(section.content, sectionIndex)}
            </section>
          ))}
        </article>
      </div>

      <footer className="performance-controls">
        <button
          onClick={() => setIsScrolling(current => !current)}
          aria-label={isScrolling ? 'Pause auto-scroll' : 'Start auto-scroll'}
          aria-pressed={isScrolling}
          type="button"
        >
          {isScrolling ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <label className="performance-speed">
          <span className="sr-only">Auto-scroll speed</span>
          <input
            type="range"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={5}
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            aria-label="Auto-scroll speed"
          />
        </label>
        {readAloudAvailable && (
          <div className="read-aloud" role="group" aria-label="Read aloud">
            <button
              onClick={toggleReadAloud}
              aria-label={
                speechStatus === 'playing'
                  ? 'Pause read-aloud'
                  : speechStatus === 'paused'
                    ? 'Resume read-aloud'
                    : 'Read script aloud'
              }
              aria-pressed={speechStatus === 'playing'}
              type="button"
            >
              {speechStatus === 'playing' ? <Pause size={18} /> : <Volume2 size={18} />}
            </button>
            {speechSupported && openRouterAvailable && (
              <select
                value={engine}
                onChange={(event) => handleEngineChanged(event.target.value as ReadAloudEngine)}
                aria-label="Read-aloud engine"
              >
                <option value="browser">Browser voice</option>
                <option value="openrouter">OpenRouter voice</option>
              </select>
            )}
            {usingOpenRouter && (
              <select
                value={ttsModel}
                onChange={(event) => handleModelChanged(event.target.value)}
                aria-label="Read-aloud model"
              >
                {TTS_MODELS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            {usingOpenRouter ? (
              ttsModelVoices ? (
                <select
                  value={ttsVoice}
                  onChange={(event) => handleVoiceChanged(event.target.value)}
                  aria-label="Read-aloud voice"
                >
                  {ttsModelVoices.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              ) : (
                // Models that take arbitrary voice ids (provider catalogues,
                // cloned voices) get a free-text field rather than a guessed list.
                <input
                  type="text"
                  value={ttsVoice}
                  onChange={(event) => handleVoiceChanged(event.target.value)}
                  placeholder="Voice id"
                  aria-label="Read-aloud voice"
                />
              )
            ) : (
              <select
                value={voiceURI}
                onChange={(event) => handleVoiceChanged(event.target.value)}
                aria-label="Read-aloud voice"
              >
                <option value="">Default voice</option>
                {voices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={speechRate}
              onChange={(event) => handleRateChanged(Number(event.target.value))}
              aria-label="Read-aloud rate"
            >
              {SPEECH_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}x
                </option>
              ))}
            </select>
            {exportAvailable && (
              <>
                <button
                  onClick={handleExport}
                  disabled={!usingOpenRouter}
                  title={
                    usingOpenRouter
                      ? 'Download the whole script as one paced recording'
                      : 'Choose an OpenRouter voice to export a recording'
                  }
                  aria-label={
                    exportStatus.phase === 'rendering'
                      ? 'Cancel recording export'
                      : 'Export as a recording'
                  }
                  type="button"
                >
                  {exportStatus.phase === 'rendering' ? <Square size={18} /> : <Download size={18} />}
                </button>
                {exportStatus.phase === 'rendering' && (
                  <label className="export-progress">
                    <span className="sr-only">Lines recorded</span>
                    <progress value={exportStatus.completed} max={exportStatus.total} />
                    {exportStatus.completed} / {exportStatus.total}
                  </label>
                )}
              </>
            )}
          </div>
        )}
        <button
          onClick={onExit}
          aria-label="Exit performance mode"
          type="button"
        >
          <X size={18} />
        </button>
        <p className="read-aloud-error" role="status" aria-live="polite">
          {speechError}
        </p>
      </footer>
    </dialog>
  )
}
