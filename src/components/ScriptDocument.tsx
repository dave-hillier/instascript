import type { FormEvent } from 'react'
import { BookmarkPlus, Check, Pencil, RotateCcw, ScanSearch, SlidersHorizontal, X } from 'lucide-react'

export interface DocumentSection {
  id: string
  title: string
  content: string
  wordCount: number
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
  informingExamples: { id: string; title: string }[]
  showScriptActions: boolean
  onReviewScript: () => void
  onPromoteToExample: () => void
  promotedToExamples: boolean
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
  informingExamples,
  showScriptActions,
  onReviewScript,
  onPromoteToExample,
  promotedToExamples,
  reviewError
}: ScriptDocumentProps) => (
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
              <div>
                {section.content
                  .split('\n')
                  .map((line, lineIndex) => ({ text: line, key: `line-${lineIndex}` }))
                  .filter(({ text }) => !text.startsWith('## ') && text.trim())
                  .map(({ text, key }) => (
                    <p key={key}>{text}</p>
                  ))}
              </div>
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
            {promotedToExamples ? (
              <p className="example-promoted" role="status">Saved to your example corpus</p>
            ) : (
              <button
                onClick={onPromoteToExample}
                aria-label="Save this script as an example"
                type="button"
              >
                <BookmarkPlus size={16} />
                Save as example
              </button>
            )}
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
