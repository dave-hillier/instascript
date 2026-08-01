import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowUp, ChevronDown, Play, RotateCcw, Square, X } from 'lucide-react'
import type { ThreadEntry } from '../services/conversationThread'

interface ConversationPanelProps {
  entries: ThreadEntry[]
  // An instruction that has been sent but whose generation has not landed in
  // the conversation yet
  pendingInstruction?: string | null
  // The live phase line while something is running, e.g. "Writing section 2 of 5..."
  isGenerating: boolean
  phaseLabel: string
  onStop: () => void
  // A generation that failed, and one a closed tab left half-finished
  errorMessage?: string
  wasInterrupted: boolean
  onRetry: () => void
  onStartOver: () => void
  reviewSummary?: string
  onDismissReview: () => void
  instruction: string
  onInstructionChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  refineError?: string | null
  // False until there is a script to talk about, which keeps the composer inert
  canRefine: boolean
  // Progress meters and usage, folded away beneath the composer
  children?: ReactNode
}

export const ConversationPanel = ({
  entries,
  pendingInstruction,
  isGenerating,
  phaseLabel,
  onStop,
  errorMessage,
  wasInterrupted,
  onRetry,
  onStartOver,
  reviewSummary,
  onDismissReview,
  instruction,
  onInstructionChange,
  onSubmit,
  refineError,
  canRefine,
  children
}: ConversationPanelProps) => {
  // Narrow screens fold the thread away so the script keeps the viewport; the
  // toggle and the folding are CSS-only above that width (see App.css)
  const [threadExpanded, setThreadExpanded] = useState(false)

  // Enter sends, Shift+Enter breaks the line — the composer convention
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (instruction.trim() && !isGenerating) {
        onSubmit(event)
      }
    }
  }

  // Folded, the toggle is the only thing left of the thread, so it carries
  // whatever the thread would otherwise be telling the user
  const summary = isGenerating
    ? { label: phaseLabel, state: 'running' }
    : errorMessage
      ? { label: 'Generation failed', state: 'error' }
      : wasInterrupted
        ? { label: 'Generation interrupted', state: 'error' }
        : reviewSummary
          ? { label: 'Review ready', state: 'notice' }
          : { label: 'Conversation', state: 'idle' }

  return (
    <aside
      className="conversation-panel"
      aria-label="Conversation"
      data-thread={threadExpanded ? 'expanded' : 'collapsed'}
    >
      <header className="thread-toggle">
        <button
          type="button"
          onClick={() => setThreadExpanded(expanded => !expanded)}
          aria-expanded={threadExpanded}
          aria-controls="conversation-thread"
          data-state={summary.state}
        >
          <ChevronDown size={16} />
          <span>{summary.label}</span>
        </button>
      </header>

      {/* The scroller reverses its single child so it stays pinned to the
          newest turn as the thread grows, with no scripted scrolling */}
      <div className="thread-scroller" id="conversation-thread">
        <ol className="thread">
          {entries.map(entry => (
            <li key={entry.id} data-kind={entry.kind}>
              {entry.kind === 'user' ? (
                <>
                  <p>{entry.text}</p>
                  {entry.chips && entry.chips.length > 0 && (
                    <ul className="turn-chips">
                      {entry.chips.map(chip => (
                        <li key={chip}>{chip}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p>
                  {entry.label}
                  {entry.detail && <span className="activity-detail">{entry.detail}</span>}
                </p>
              )}
            </li>
          ))}

          {pendingInstruction && (
            <li data-kind="user">
              <p>{pendingInstruction}</p>
            </li>
          )}

          {isGenerating && (
            <li data-kind="running">
              <p role="status" aria-live="polite">{phaseLabel}</p>
              <button
                onClick={onStop}
                aria-label="Stop script generation"
                type="button"
                className="stop-button-with-text"
              >
                <Square size={13} />
                Stop
              </button>
            </li>
          )}

          {errorMessage && !isGenerating && (
            <li data-kind="notice">
              <div role="alert" className="generation-notice" data-kind="error">
                <p>
                  <strong>Generation failed.</strong> {errorMessage}
                </p>
                <div className="notice-actions">
                  <button
                    onClick={onRetry}
                    aria-label="Retry script generation from where it stopped"
                    type="button"
                  >
                    <Play size={14} />
                    Retry
                  </button>
                  <button
                    onClick={onStartOver}
                    aria-label="Start the script generation over from scratch"
                    type="button"
                  >
                    <RotateCcw size={14} />
                    Start over
                  </button>
                </div>
              </div>
            </li>
          )}

          {wasInterrupted && (
            <li data-kind="notice">
              <div role="status" className="generation-notice" data-kind="interrupted">
                <p>
                  This generation was interrupted before it finished. Everything
                  written so far is saved.
                </p>
                <div className="notice-actions">
                  <button onClick={onRetry} aria-label="Resume script generation" type="button">
                    <Play size={14} />
                    Resume
                  </button>
                  <button
                    onClick={onStartOver}
                    aria-label="Start the script generation over from scratch"
                    type="button"
                  >
                    <RotateCcw size={14} />
                    Start over
                  </button>
                </div>
              </div>
            </li>
          )}

          {reviewSummary && !isGenerating && (
            <li data-kind="notice">
              <div
                role="status"
                aria-live="polite"
                className="generation-notice"
                data-kind="review"
              >
                <p>{reviewSummary}</p>
                <div className="notice-actions">
                  <button onClick={onDismissReview} aria-label="Dismiss review summary" type="button">
                    <X size={14} />
                    Dismiss
                  </button>
                </div>
              </div>
            </li>
          )}
        </ol>
      </div>

      <footer className="composer-area">
        {refineError && (
          <p role="alert" className="refine-error">
            Refinement failed: {refineError}. Your instruction is preserved below.
          </p>
        )}
        <form className="composer" aria-label="Refine this script" onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="refine-instruction">
            Refine this script with a follow-up instruction
          </label>
          <textarea
            id="refine-instruction"
            value={instruction}
            onChange={event => onInstructionChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={Math.min(6, Math.max(2, instruction.split('\n').length + 1))}
            disabled={!canRefine || isGenerating}
            placeholder={
              canRefine
                ? 'Ask for a change — e.g. make the induction slower'
                : 'Waiting for the script...'
            }
          />
          <button
            type="submit"
            disabled={!instruction.trim() || !canRefine || isGenerating}
            aria-label="Send instruction"
          >
            <ArrowUp size={18} />
          </button>
        </form>
        {children}
      </footer>
    </aside>
  )
}
