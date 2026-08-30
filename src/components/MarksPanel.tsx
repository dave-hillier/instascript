import { useState } from 'react'
import { Check, Crosshair, Flag, Pencil, RotateCcw, ScanSearch, Undo2, X } from 'lucide-react'
import { markPlacementNote, type SectionMark } from '../services/sectionMarkView'

interface MarksPanelProps {
  marks: SectionMark[]
  // Which mark the reader is looking at, so the panel and the body agree
  focusedMarkId: string | null
  onFocusMark: (markId: string | null) => void
  // Whether a mark can be spent is the view model's decision, carried on the
  // mark itself: sectionMarkView weighs the run in flight and the section's
  // existence together, where it can be tested (M4)
  onSpend: (mark: SectionMark) => void
  onDismiss: (mark: SectionMark) => void
  // A flag is the reader's own, so only a flag can be reworded
  onRelabel: (mark: SectionMark, label: string) => void
  onAnnotate: (mark: SectionMark, note: string) => void
  dismissedCount: number
  onRestoreDismissed: () => void
}

interface MarkDraft {
  markId: string
  label: string
  note: string
}

// The marks on the script, listed where they can be read against each other.
//
// A model's finding and a reader's flag are told apart on sight and in what
// they offer: a finding quotes the passage it objects to and can be shown,
// spent or dismissed, but never reworded, because it is a judgement the model
// made and the log has to keep saying what that judgement was. A flag is the
// reader's own note, and its label and annotation are theirs to change.
export const MarksPanel = ({
  marks,
  focusedMarkId,
  onFocusMark,
  onSpend,
  onDismiss,
  onRelabel,
  onAnnotate,
  dismissedCount,
  onRestoreDismissed
}: MarksPanelProps) => {
  const [draft, setDraft] = useState<MarkDraft | null>(null)

  const submitDraft = (event: React.FormEvent, mark: SectionMark): void => {
    event.preventDefault()
    if (!draft) return
    onRelabel(mark, draft.label.trim() === '' ? mark.label : draft.label.trim())
    onAnnotate(mark, draft.note)
    setDraft(null)
  }

  if (marks.length === 0 && dismissedCount === 0) return null

  return (
    <aside className="marks-panel" aria-label="Marks on this script">
      <h2>Marks</h2>
      {marks.length === 0 ? (
        <p className="marks-empty">Nothing marked.</p>
      ) : (
        <ol>
          {marks.map(mark => {
            const note = markPlacementNote(mark)
            const editing = draft?.markId === mark.id
            return (
              <li key={mark.id}>
                <article
                  id={`${mark.id}_details`}
                  data-mark-kind={mark.kind}
                  aria-labelledby={`${mark.id}_label`}
                  aria-current={focusedMarkId === mark.id ? 'true' : undefined}
                >
                  <header>
                    <h3 id={`${mark.id}_label`}>
                      {mark.kind === 'flag' ? <Flag size={14} aria-hidden="true" /> : <ScanSearch size={14} aria-hidden="true" />}
                      {mark.label}
                    </h3>
                    <p className="mark-origin">
                      {mark.origin} on "{mark.section}"
                    </p>
                  </header>

                  {mark.quotes.map((quote, index) => (
                    <blockquote key={`${mark.id}_quote_${index}`}>{quote}</blockquote>
                  ))}

                  {mark.reason && <p className="mark-reason">{mark.reason}</p>}

                  {/* A mark that could not be drawn says so rather than
                      disappearing: a passage that quietly stopped being
                      highlighted reads as one that was repaired */}
                  {note && (
                    <p className="mark-placement" role="note">
                      {note}
                    </p>
                  )}

                  {editing ? (
                    <form
                      className="mark-edit-form"
                      aria-label={`Rename your mark on "${mark.section}"`}
                      onSubmit={event => submitDraft(event, mark)}
                    >
                      <label htmlFor={`${mark.id}_label_input`}>Label</label>
                      <input
                        id={`${mark.id}_label_input`}
                        type="text"
                        value={draft.label}
                        onChange={event => setDraft({ ...draft, label: event.target.value })}
                        autoFocus
                      />
                      <label htmlFor={`${mark.id}_note_input`}>Note</label>
                      <textarea
                        id={`${mark.id}_note_input`}
                        value={draft.note}
                        onChange={event => setDraft({ ...draft, note: event.target.value })}
                        rows={3}
                      />
                      <div className="mark-actions">
                        <button type="submit">
                          <Check size={14} aria-hidden="true" />
                          Save
                        </button>
                        <button type="button" onClick={() => setDraft(null)}>
                          <X size={14} aria-hidden="true" />
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="mark-actions">
                      {/* aria-controls names the element the highlight is
                          actually drawn in, which is the run the mark begins
                          in rather than the mark's own id: one mark can be cut
                          across several runs by another overlapping it */}
                      {mark.anchorRunKey && (
                        <button
                          type="button"
                          aria-controls={mark.anchorRunKey}
                          aria-label={`Show the marked passage in "${mark.section}"`}
                          onClick={() => onFocusMark(mark.id)}
                        >
                          <Crosshair size={14} aria-hidden="true" />
                          Show
                        </button>
                      )}
                      {mark.kind === 'flag' && (
                        <button
                          type="button"
                          aria-label={`Rename your mark on "${mark.section}"`}
                          onClick={() => setDraft({ markId: mark.id, label: mark.label, note: mark.reason })}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          Rename
                        </button>
                      )}
                      {mark.spendable && (
                        <button
                          type="button"
                          className="mark-spend"
                          aria-label={`Rewrite "${mark.section}" for this mark. ${mark.spendNote}`}
                          onClick={() => onSpend(mark)}
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                          Rewrite
                          <small>{mark.spendNote}</small>
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={
                          mark.kind === 'flag'
                            ? `Discard your mark on "${mark.section}"`
                            : `Dismiss this finding about "${mark.section}". The conversation keeps it.`
                        }
                        onClick={() => onDismiss(mark)}
                      >
                        <X size={14} aria-hidden="true" />
                        {mark.kind === 'flag' ? 'Discard' : 'Dismiss'}
                      </button>
                    </div>
                  )}
                </article>
              </li>
            )
          })}
        </ol>
      )}

      {/* Dismissing hides a finding here and changes nothing in the
          conversation, so there is always a way back to it */}
      {dismissedCount > 0 && (
        <p className="marks-dismissed">
          <button type="button" onClick={onRestoreDismissed}>
            <Undo2 size={14} aria-hidden="true" />
            Show {dismissedCount} dismissed {dismissedCount === 1 ? 'finding' : 'findings'}
          </button>
        </p>
      )}
    </aside>
  )
}
