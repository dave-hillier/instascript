import { Fragment, useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, X } from 'lucide-react'
import { tokenizeScriptLine } from '../utils/scriptLineTokens'
import { ScriptSpeaker, buildSpeechPlan, isSpeechSynthesisSupported } from '../services/speech'
import { BrowserSpeechEngine, OpenRouterSpeechEngine, type SpeechEngine } from '../services/speechEngines'
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

// Full-screen read-aloud view (stories 4.2, 4.4 and 4.5): larger reading text,
// pacing marks and stage directions muted, optional auto-scroll with
// adjustable speed, and read-aloud through either browser speech synthesis or
// an OpenRouter text-to-speech model, with engine, model, voice and rate
// selection. Rendered as a modal <dialog>, so Escape and focus containment
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

  const readAloudAvailable = speechSupported || openRouterAvailable
  const usingOpenRouter = engine === 'openrouter' && openRouterAvailable
  const ttsModelVoices = findTtsModel(ttsModel)?.voices

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

  // Engine and model changes swap out the voice entirely, so an in-progress
  // read stops rather than switching timbre mid-sentence. A voice change
  // within one engine applies from the next utterance.
  const handleEngineChanged = (next: ReadAloudEngine) => {
    stopReadAloud()
    setSpeechError(null)
    setEngine(next)
    setReadAloudEngine(next)
  }

  const handleModelChanged = (model: string) => {
    stopReadAloud()
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
