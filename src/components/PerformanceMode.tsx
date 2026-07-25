import { Fragment, useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, X } from 'lucide-react'
import { tokenizeScriptLine } from '../utils/scriptLineTokens'
import { ScriptSpeaker, buildSpeechPlan, isSpeechSynthesisSupported } from '../services/speech'

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

// Full-screen read-aloud view (stories 4.2 and 4.4): larger reading text,
// pacing marks and stage directions muted, optional auto-scroll with
// adjustable speed, and browser speech synthesis with voice/rate selection.
// Rendered as a modal <dialog>, so Escape and focus containment come from the
// platform; refs exist only for the imperative dialog, scroll and speech APIs.
export const PerformanceMode = ({ title, sections, showSectionTitles, onExit }: PerformanceModeProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isScrolling, setIsScrolling] = useState(false)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)

  const speechSupported = isSpeechSynthesisSupported()
  // The speaker is a handle onto the imperative speechSynthesis API, kept in
  // a ref for the same reason as the dialog element.
  const speakerRef = useRef<ScriptSpeaker | null>(null)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>('idle')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceURI, setVoiceURI] = useState('')
  const [speechRate, setSpeechRate] = useState(1)
  const [spokenParagraphKey, setSpokenParagraphKey] = useState<string | null>(null)

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
  useEffect(() => {
    if (!speechSupported) return
    return () => {
      speakerRef.current?.stop()
      speakerRef.current = null
      window.speechSynthesis.cancel()
    }
  }, [speechSupported])

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

  const findVoice = (uri: string) =>
    voices.find((voice) => voice.voiceURI === uri) ?? null

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
    const speaker = new ScriptSpeaker(
      buildSpeechPlan(sections),
      { voice: findVoice(voiceURI), rate: speechRate },
      {
        onParagraphSpoken: setSpokenParagraphKey,
        onFinished: () => {
          speakerRef.current = null
          setSpeechStatus('idle')
          setSpokenParagraphKey(null)
        },
      }
    )
    speakerRef.current = speaker
    setSpeechStatus('playing')
    speaker.start()
  }

  const handleVoiceChanged = (uri: string) => {
    setVoiceURI(uri)
    speakerRef.current?.setVoice(findVoice(uri))
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
        {speechSupported && (
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
      </footer>
    </dialog>
  )
}
