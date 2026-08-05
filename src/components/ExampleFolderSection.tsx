import { useState } from 'react'
import { Check, FileText, FolderOpen, Pencil, Trash2, Wand2, X } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import { exampleFolder, parseTags, UNFILED_FOLDER } from '../services/exampleCorpus'
import { needsDirectAddress } from '../services/importAssist'
import { countWords } from '../utils/scriptMetrics'
import { describeSelectionCount } from '../utils/exampleDisplay'

interface UserExampleDetailsFormProps {
  example: ExampleRecord
  folders: string[]
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
}

// Tags and folder for one example, saved together: both are how the example
// is filed, and one Save keeps the row from sprouting two buttons. The
// folder is chosen from the folders that exist rather than typed, so a
// mistyped name cannot quietly strand an example in a folder of its own.
const UserExampleDetailsForm = ({
  example,
  folders,
  onDetailsSaved
}: UserExampleDetailsFormProps) => {
  const [tagText, setTagText] = useState(example.tags.join(', '))
  const [folder, setFolder] = useState(exampleFolder(example))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onDetailsSaved(example.id, { tags: parseTags(tagText), folder })
  }

  return (
    <form
      className="example-details-form"
      aria-label={`Edit tags and folder for ${example.title}`}
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor={`${example.id}_tags`}>
        Tags for {example.title}, comma separated
      </label>
      <input
        id={`${example.id}_tags`}
        type="text"
        value={tagText}
        onChange={event => setTagText(event.target.value)}
        placeholder="tags, comma separated"
      />
      <label className="sr-only" htmlFor={`${example.id}_folder`}>
        Folder for {example.title}
      </label>
      <select
        id={`${example.id}_folder`}
        value={folder}
        onChange={event => setFolder(event.target.value)}
      >
        {folders.map(name => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button type="submit" aria-label={`Save tags and folder for ${example.title}`}>
        <Check size={14} />
        Save
      </button>
    </form>
  )
}

interface FolderNameProps {
  folder: string
  headingId: string
  onRenamed: (from: string, to: string) => void
}

// The folder's name, and renaming it in place: the pencil swaps the heading
// for an input, Enter or the check saves, Escape or the cross discards —
// the same gesture as renaming a script.
const FolderName = ({ folder, headingId, onRenamed }: FolderNameProps) => {
  // null when displaying; the in-progress text while renaming
  const [draft, setDraft] = useState<string | null>(null)

  if (draft === null) {
    return (
      <h3 id={headingId}>
        <FolderOpen size={16} aria-hidden="true" />
        {folder}
        <button
          type="button"
          onClick={() => setDraft(folder)}
          aria-label={`Rename folder ${folder}`}
        >
          <Pencil size={13} />
        </button>
      </h3>
    )
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== folder) onRenamed(folder, trimmed)
    setDraft(null)
  }

  return (
    <form
      className="example-folder-rename"
      aria-label={`Rename folder ${folder}`}
      onSubmit={event => {
        event.preventDefault()
        commit()
      }}
    >
      <label className="sr-only" htmlFor={`${headingId}_name`}>
        New name for folder {folder}
      </label>
      <input
        id={`${headingId}_name`}
        type="text"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setDraft(null)
        }}
        autoFocus
      />
      <button type="submit" aria-label={`Save the new name for ${folder}`}>
        <Check size={16} />
      </button>
      <button type="button" onClick={() => setDraft(null)} aria-label="Cancel renaming">
        <X size={16} />
      </button>
    </form>
  )
}

interface ExampleFolderSectionProps {
  folder: string
  headingId: string
  examples: ExampleRecord[]
  folders: string[]
  active: boolean
  selectionCounts: Record<string, number>
  // The example being rewritten into direct address right now, if any
  rewritingExampleId: string | null
  onActivated: (folder: string) => void
  onFolderRenamed: (from: string, to: string) => void
  onFolderDeleted: (folder: string) => void
  onExampleDeleted: (example: ExampleRecord) => void
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
  onOpenAsScript: (example: ExampleRecord) => void
  onRewriteExample: (example: ExampleRecord) => void
}

// One folder of user examples: which folder is grounding generation is a
// single choice across the page, so the control is a radio rather than a
// per-folder switch.
export const ExampleFolderSection = ({
  folder,
  headingId,
  examples,
  folders,
  active,
  selectionCounts,
  rewritingExampleId,
  onActivated,
  onFolderRenamed,
  onFolderDeleted,
  onExampleDeleted,
  onDetailsSaved,
  onOpenAsScript,
  onRewriteExample
}: ExampleFolderSectionProps) => {
  const words = examples.reduce((total, example) => total + countWords(example.content), 0)

  return (
    <section className="example-folder" aria-labelledby={headingId} data-active={active}>
      <header>
        {/* Unfiled is where examples with no folder live rather than a
            folder in its own right, so there is no name to rename */}
        {folder === UNFILED_FOLDER ? (
          <h3 id={headingId}>
            <FolderOpen size={16} aria-hidden="true" />
            {folder}
          </h3>
        ) : (
          <FolderName folder={folder} headingId={headingId} onRenamed={onFolderRenamed} />
        )}
        <p className="example-folder-meta">
          {examples.length === 0
            ? 'Empty'
            : `${examples.length} ${examples.length === 1 ? 'example' : 'examples'} · ${words.toLocaleString('en-US')} words`}
        </p>
        <label className="radio-field">
          <input
            type="radio"
            name="active-example-folder"
            value={folder}
            checked={active}
            onChange={() => onActivated(folder)}
          />
          <span>{active ? 'Used for generation' : 'Use for generation'}</span>
        </label>
        <button
          type="button"
          className="example-folder-delete"
          onClick={() => onFolderDeleted(folder)}
        >
          <Trash2 size={14} />
          Delete folder
        </button>
      </header>

      {examples.length === 0 ? (
        <p className="example-folder-empty">
          Nothing filed here yet. Import into this folder, or move an example
          into it from another.
        </p>
      ) : (
        <ul className="example-list">
          {examples.map(example => (
            <li key={example.id}>
              <div className="example-summary">
                <h4>{example.title}</h4>
                <p className="example-meta">
                  {countWords(example.content).toLocaleString('en-US')} words
                  {' · '}
                  {describeSelectionCount(selectionCounts[example.id] ?? 0)}
                  {example.sourceScriptId && ' · from your library'}
                </p>
                <UserExampleDetailsForm
                  key={`${example.id}_${example.tags.join(',')}_${exampleFolder(example)}`}
                  example={example}
                  folders={folders}
                  onDetailsSaved={onDetailsSaved}
                />
              </div>
              <div className="example-actions">
                {/* Offered only where there is something to rewrite: an
                    example that already speaks to the listener has nothing
                    for the pass to do */}
                {needsDirectAddress(example.content) && (
                  <button
                    onClick={() => onRewriteExample(example)}
                    disabled={rewritingExampleId !== null}
                    aria-label={`Rewrite ${example.title} into direct address`}
                    type="button"
                  >
                    <Wand2 size={16} />
                    {rewritingExampleId === example.id ? 'Rewriting…' : 'Direct address'}
                  </button>
                )}
                <button
                  onClick={() => onOpenAsScript(example)}
                  aria-label={`Open ${example.title} as a script`}
                  type="button"
                >
                  <FileText size={16} />
                  Open as script
                </button>
                <button
                  onClick={() => onExampleDeleted(example)}
                  aria-label={`Delete example ${example.title}`}
                  type="button"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
