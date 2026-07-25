import { Fragment, useEffect, useRef, useState } from 'react'
import { Pause, Play, X } from 'lucide-react'
import { tokenizeScriptLine } from '../utils/scriptLineTokens'

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

// Full-screen read-aloud view (story 4.2): larger reading text, pacing marks
// and stage directions muted, optional auto-scroll with adjustable speed.
// Rendered as a modal <dialog>, so Escape and focus containment come from the
// platform; refs exist only for the imperative dialog and scroll APIs.
export const PerformanceMode = ({ title, sections, showSectionTitles, onExit }: PerformanceModeProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isScrolling, setIsScrolling] = useState(false)
  const [speed, setSpeed] = useState(DEFAULT_SPEED)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return
    dialog.showModal()
    return () => dialog.close()
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

  const renderLines = (content: string, sectionIndex: number) =>
    content
      .split('\n')
      .map((line, lineIndex) => ({ line, key: `line-${sectionIndex}-${lineIndex}` }))
      .filter(({ line }) => line.trim() && !line.startsWith('## '))
      .map(({ line, key }) => (
        <p key={key}>
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
      ))

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
