import { Fragment, type FormEvent } from 'react'
import { BookmarkPlus, Check, Pencil, RotateCcw, ScanSearch, SlidersHorizontal, X } from 'lucide-react'
import type { GenerationToolCallStatus } from '../types/conversation'
import { sectionStatusNote } from '../services/scriptProjection'
import { readBodySelection } from '../services/markStore'
import { MarksPanel } from './MarksPanel'
import type { SectionMark, SectionMarkView } from '../services/sectionMarkView'

export interface DocumentSection {
  id: string
  title: string
  content: string
  wordCount: number
  // The verdict the writing tool reached on this body. Absent when the section
  // was written and kept without incident, which is every ordinary section.
  status?: GenerationToolCallStatus
  statusReason?: string
}

interface ScriptDocumentProps {
  sections: DocumentSection[]
  fullContent: string
  showSectionTitles: boolean
  // Section-level actions are hidden while a generation is in flight
  canEditSections: boolean
  isGenerating: boolean
  instructionTarget: string | null
  instructionText: string
  onInstructionTextChange: (value: string) => void
  onToggleInstructionForm: (sectionTitle: string) => void
  onInstructionSubmit: (event: FormEvent, sectionTitle: string) => void
  onRegenerateSection: (sectionTitle: string) => void
  editTarget: string | null
  editDraft: string
  onEditDraftChange: (value: string) => void
  onStartEdit: (sectionTitle: string, content: string) => void
  onCancelEdit: () => void
  onEditSubmit: (event: FormEvent, sectionTitle: string) => void
  // Provenance and whole-script actions, shown once the script is finished
  // Marks, decided in services/sectionMarkView and only rendered here: which
  // passages are highlighted, what covers each stretch of text, and what each
  // mark offers. Keyed by section title, as the projection keys sections.
  markViews: Record<string, SectionMarkView>
  marks: SectionMark[]
  focusedMarkId: string | null
  // The run element to bring into view, when the reader asked to be shown one
  focusedRunKey: string | null
  onFocusMark: (markId: string | null) => void
  // The reader chose a passage in a section body — by dragging over it, in
  // which case the text is read off the element that raised the event and
  // never found by a global query, or by pressing the control for one of the
  // units the view model offers the keyboard. Both send the same thing: the
  // words, for the page to resolve against that body.
  onPassageSelected: (sectionTitle: string, passage: string) => void
  // Why the last passage could not be marked, when it could not be
  selectionNote: string | null
  onSpendMark: (mark: SectionMark) => void
  onDismissMark: (mark: SectionMark) => void
  onRelabelMark: (mark: SectionMark, label: string) => void
  onAnnotateMark: (mark: SectionMark, note: string) => void
  dismissedCount: number
  onRestoreDismissed: () => void
  informingExamples: { id: string; title: string }[]
  showScriptActions: boolean
  onReviewScript: () => void
  onPromoteToExample: () => void
  // The corpus folder this script is saved into, or null when it is not
  promotedFolder: string | null
  reviewError?: string | null
}

export const ScriptDocument = ({
  sections,
  fullContent,
  showSectionTitles,
  canEditSections,
  isGenerating,
  instructionTarget,
  instructionText,
  onInstructionTextChange,
  onToggleInstructionForm,
  onInstructionSubmit,
  onRegenerateSection,
  editTarget,
  editDraft,
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onEditSubmit,
  markViews,
  marks,
  focusedMarkId,
  focusedRunKey,
  onFocusMark,
  onPassageSelected,
  selectionNote,
  onSpendMark,
  onDismissMark,
  onRelabelMark,
  onAnnotateMark,
  dismissedCount,
  onRestoreDismissed,
  informingExamples,
  showScriptActions,
  onReviewScript,
  onPromoteToExample,
  promotedFolder,
  reviewError
}: ScriptDocumentProps) => {
  // Ref callback on the one run the reader asked to be shown, in the manner
  // PerformanceMode follows the spoken paragraph: the element hands itself in,
  // nothing is looked up, and nothing about the page is changed but where it
  // is scrolled to.
  const showMarkedPassage = (element: HTMLElement | null): void => {
    if (!element) return
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ block: 'center', behavior: prefersReducedMotion ? 'auto' : 'smooth' })
  }

  // The selection is read from the element the handler is on, so a drag that
  // began outside this body cannot be pinned to words inside it.
  const reportSelection = (
    event: { currentTarget: HTMLElement },
    sectionTitle: string
  ): void => {
    const selected = readBodySelection(event.currentTarget)
    if (selected) onPassageSelected(sectionTitle, selected)
  }

  return (
  <section className="document-pane" aria-label="Script">
    {/* With titles hidden (story 2.5) the header stays in the DOM: the
        heading is visually hidden via CSS and the section actions reveal
        on hover or keyboard focus of the section, so functionality is
        reachable in both modes */}
    <article data-section-titles={showSectionTitles ? 'visible' : 'hidden'}>
      {sections.length > 0 ? (
        sections.map((section, index) => (
          <section key={`section-${index}`}>
            <header>
              <h2>{section.title}</h2>
              {canEditSections && (
                <div className="section-actions">
                  <button
                    onClick={() => onStartEdit(section.title, section.content)}
                    aria-label={`Edit ${section.title} section`}
                    type="button"
                  >
                    <Pencil size={16} />
                    Edit
                  </button>
                  <button
                    onClick={() => onRegenerateSection(section.title)}
                    aria-label={`Regenerate ${section.title} section`}
                    type="button"
                  >
                    <RotateCcw size={16} />
                    Regenerate
                  </button>
                  <button
                    onClick={() => onToggleInstructionForm(section.title)}
                    aria-expanded={instructionTarget === section.title}
                    aria-controls={`${section.id}_instruction`}
                    aria-label={`Regenerate ${section.title} section with instructions`}
                    type="button"
                  >
                    <SlidersHorizontal size={16} />
                  </button>
                </div>
              )}
            </header>
            {/* A section kept despite failing the length window says so where
                it is read: a note on the section, not an error, but never
                silent — a waived section must not read as a clean one. Whether
                a note is due, and its wording, is sectionStatusNote's decision
                so it can be tested without a DOM. */}
            {sectionStatusNote(section) && (
              <p className="section-waiver" role="note">
                {sectionStatusNote(section)}
              </p>
            )}
            {instructionTarget === section.title && canEditSections && (
              <form
                className="regenerate-form"
                id={`${section.id}_instruction`}
                aria-label={`Regenerate ${section.title} with instructions`}
                onSubmit={event => onInstructionSubmit(event, section.title)}
              >
                <label className="sr-only" htmlFor={`${section.id}_instruction_input`}>
                  How should the {section.title} section change? Leave empty for a standard rewrite.
                </label>
                <input
                  id={`${section.id}_instruction_input`}
                  type="text"
                  value={instructionText}
                  onChange={event => onInstructionTextChange(event.target.value)}
                  placeholder="e.g. less repetition, more breathing focus"
                  autoFocus
                />
                <button type="submit">
                  <RotateCcw size={14} />
                  Regenerate
                </button>
              </form>
            )}
            {editTarget === section.title && canEditSections ? (
              <form
                className="section-edit-form"
                aria-label={`Edit ${section.title} section`}
                onSubmit={event => onEditSubmit(event, section.title)}
              >
                <label className="sr-only" htmlFor={`${section.id}_edit_input`}>
                  Text of the {section.title} section
                </label>
                <textarea
                  id={`${section.id}_edit_input`}
                  value={editDraft}
                  onChange={event => onEditDraftChange(event.target.value)}
                  rows={Math.max(6, editDraft.split('\n').length + 1)}
                  autoFocus
                />
                <div className="section-edit-actions">
                  <button type="submit" disabled={!editDraft.trim()}>
                    <Check size={16} />
                    Save
                  </button>
                  <button type="button" onClick={onCancelEdit}>
                    <X size={16} />
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <Fragment>
              {/* Selecting words here is how a passage gets flagged. The
                  handlers read the selection off this element and change
                  nothing; every decision about what is drawn was made by
                  sectionMarkView before the render began. */}
              <div
                className="section-body"
                onMouseUp={event => reportSelection(event, section.title)}
                onKeyUp={event => reportSelection(event, section.title)}
                onClick={event => reportSelection(event, section.title)}
              >
                {(markViews[section.title]?.paragraphs ?? []).map(paragraph => (
                  <p key={paragraph.key}>
                    {paragraph.runs.map(run =>
                      run.markIds.length === 0 ? (
                        <Fragment key={run.key}>{run.text}</Fragment>
                      ) : (
                        <mark
                          key={run.key}
                          id={run.key}
                          data-mark-tone={run.tone}
                          data-mark-focused={run.focused || undefined}
                          ref={run.key === focusedRunKey ? showMarkedPassage : undefined}
                        >
                          {/* A <mark> is neither focusable nor interactive, so
                              an aria-describedby pointing at the panel entry is
                              not surfaced; what covers this passage is said in
                              words instead, visually hidden. The wording is
                              sectionMarkView's decision. */}
                          <span className="sr-only">{run.announcement}</span>
                          {run.text}
                        </mark>
                      )
                    )}
                  </p>
                ))}
                {/* Where a dragged selection is committed. It is the POINTER
                    path and only that: a keyboard cannot make a selection in
                    this prose at all, so pressing it without one truthfully
                    reports that no passage was chosen, and the keyboard's own
                    way in is the unit list below.

                    It carries no handler of its own on purpose: the selection
                    has to be read from the body element, and the click
                    bubbling to the body's own handler is what hands that
                    element in as currentTarget — nothing is looked up. The
                    mousedown default is suppressed so pressing it does not
                    clear the selection it is about to mark. */}
                {/* Gated on the same decision the unit list is gated on: a
                    section still being written, or one with no prose yet, has
                    nothing markable in it, and a tab stop whose only possible
                    answer is "not yet" is a dead one. */}
                {markViews[section.title]?.marking && (
                  <p className="mark-selection">
                    <button
                      type="button"
                      onMouseDown={event => event.preventDefault()}
                      aria-label={`Mark the words selected in the ${section.title} section`}
                    >
                      <BookmarkPlus size={14} aria-hidden="true" />
                      Mark selection
                    </button>
                  </p>
                )}
              </div>
              {/* The keyboard's way in, which the selection above cannot be.
                  A selection cannot be MADE in non-editable prose without
                  caret browsing, which is off by default and which a page
                  cannot turn on, so there is nothing for the body's key
                  handler to read. These controls do not read a selection at
                  all: each one carries the text of a paragraph or a sentence
                  and hands it to the same resolution a drag goes through, so
                  a keyboard-made mark is the same kind of thing as a
                  pointer-made one and is refused by the same rules.

                  They sit OUTSIDE the body element on purpose: a click inside
                  it bubbles to the body's own selection handler, and a unit
                  press would then be read as a selection as well.

                  What the units are, what each is called, and whether there
                  are any to offer at all are sectionMarkView's decisions — a
                  section still being written offers none, so its prose gains
                  no tab stops that could only answer "not yet". */}
              {markViews[section.title]?.marking && (
                <details className="mark-units">
                  <summary>{markViews[section.title]?.marking?.summary}</summary>
                  <ul>
                    {(markViews[section.title]?.marking?.units ?? []).map(unit => (
                      <li key={unit.key} data-unit-kind={unit.kind}>
                        <button
                          type="button"
                          aria-label={unit.name}
                          onClick={() => onPassageSelected(section.title, unit.text)}
                        >
                          <BookmarkPlus size={12} aria-hidden="true" />
                          <span aria-hidden="true">{unit.preview}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              </Fragment>
            )}
          </section>
        ))
      ) : fullContent ? (
        fullContent
          .split('\n')
          .map((paragraph, paragraphIndex) => ({ text: paragraph, key: `paragraph-${paragraphIndex}` }))
          .filter(({ text }) => text.trim())
          .map(({ text, key }) => (
            <p key={key}>{text}</p>
          ))
      ) : (
        <p className="document-empty">
          {isGenerating
            ? 'The script will appear here as it is written.'
            : 'Nothing written yet. Ask for what you want in the conversation.'}
        </p>
      )}
    </article>

    {/* What became of a mark, in the reader's own terms: the passage that was
        marked, or why one could not be — too short to be found again, or one
        the body repeats.

        Rendered ALWAYS, empty until there is something to say. A live region
        inserted into the document together with its text is commonly not
        announced at all, and the first mark a reader makes is exactly when
        they need to hear that it worked. */}
    <p className="selection-note" role="status">
      {selectionNote ?? ''}
    </p>

    <MarksPanel
      marks={marks}
      focusedMarkId={focusedMarkId}
      onFocusMark={onFocusMark}
      onSpend={onSpendMark}
      onDismiss={onDismissMark}
      onRelabel={onRelabelMark}
      onAnnotate={onAnnotateMark}
      dismissedCount={dismissedCount}
      onRestoreDismissed={onRestoreDismissed}
    />

    {!isGenerating && (informingExamples.length > 0 || showScriptActions) && (
      <footer className="script-utility">
        {informingExamples.length > 0 ? (
          <details className="example-provenance">
            <summary>
              Grounded in {informingExamples.length}{' '}
              {informingExamples.length === 1 ? 'example' : 'examples'}
            </summary>
            <ul>
              {informingExamples.map(example => (
                <li key={example.id}>{example.title}</li>
              ))}
            </ul>
          </details>
        ) : (
          <span />
        )}
        {showScriptActions && (
          <div className="script-utility-actions">
            <button
              onClick={onReviewScript}
              aria-label="Review this script for cohesion and length"
              type="button"
            >
              <ScanSearch size={16} />
              Review script
            </button>
            {/* A saved script keeps the action: the script moves on after it
                was saved, and saving again updates the example held for it
                rather than adding a second copy */}
            {promotedFolder && (
              <p className="example-promoted" role="status">
                In your corpus, filed under "{promotedFolder}"
              </p>
            )}
            <button
              onClick={onPromoteToExample}
              aria-label={
                promotedFolder
                  ? 'Update the example saved for this script'
                  : 'Save this script as an example'
              }
              type="button"
            >
              <BookmarkPlus size={16} />
              {promotedFolder ? 'Update example' : 'Save as example'}
            </button>
          </div>
        )}
      </footer>
    )}

    {reviewError && !isGenerating && (
      <p role="alert" className="review-error">
        Review failed: {reviewError}
      </p>
    )}
  </section>
  )
}
