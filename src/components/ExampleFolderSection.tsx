import { useState } from 'react'
import { Check, FolderOpen, Trash2 } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import { exampleFolder, parseTags } from '../services/exampleCorpus'
import { countWords } from '../utils/scriptMetrics'
import { describeSelectionCount, FOLDER_SUGGESTIONS_ID } from '../utils/exampleDisplay'

interface UserExampleDetailsFormProps {
  example: ExampleRecord
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
}

// Tags and folder for one example, saved together: both are how the example
// is filed, and one Save keeps the row from sprouting two buttons.
const UserExampleDetailsForm = ({ example, onDetailsSaved }: UserExampleDetailsFormProps) => {
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
      <input
        id={`${example.id}_folder`}
        type="text"
        list={FOLDER_SUGGESTIONS_ID}
        value={folder}
        onChange={event => setFolder(event.target.value)}
        placeholder="folder"
      />
      <button type="submit" aria-label={`Save tags and folder for ${example.title}`}>
        <Check size={14} />
        Save
      </button>
    </form>
  )
}

interface ExampleFolderSectionProps {
  folder: string
  headingId: string
  examples: ExampleRecord[]
  active: boolean
  selectionCounts: Record<string, number>
  onActivated: (folder: string) => void
  onFolderDeleted: (folder: string) => void
  onExampleDeleted: (example: ExampleRecord) => void
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
}

// One folder of user examples: which folder is grounding generation is a
// single choice across the page, so the control is a radio rather than a
// per-folder switch.
export const ExampleFolderSection = ({
  folder,
  headingId,
  examples,
  active,
  selectionCounts,
  onActivated,
  onFolderDeleted,
  onExampleDeleted,
  onDetailsSaved
}: ExampleFolderSectionProps) => {
  const words = examples.reduce((total, example) => total + countWords(example.content), 0)

  return (
    <section className="example-folder" aria-labelledby={headingId} data-active={active}>
      <header>
        <h3 id={headingId}>
          <FolderOpen size={16} aria-hidden="true" />
          {folder}
        </h3>
        <p className="example-folder-meta">
          {examples.length} {examples.length === 1 ? 'example' : 'examples'}
          {' · '}
          {words.toLocaleString('en-US')} words
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

      <ul className="example-list">
        {examples.map(example => (
          <li key={example.id}>
            <div className="example-summary">
              <h4>{example.title}</h4>
              <p className="example-meta">
                {countWords(example.content).toLocaleString('en-US')} words
                {' · '}
                {describeSelectionCount(selectionCounts[example.id] ?? 0)}
              </p>
              <UserExampleDetailsForm
                key={`${example.id}_${example.tags.join(',')}_${exampleFolder(example)}`}
                example={example}
                onDetailsSaved={onDetailsSaved}
              />
            </div>
            <div className="example-actions">
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
    </section>
  )
}
