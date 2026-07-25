import { useReducer, useState } from 'react'
import { Trash2, Check } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import {
  getAllExamples,
  importExampleFile,
  deleteUserExample,
  updateUserExampleTags,
  parseTags
} from '../services/exampleCorpus'
import { countWords } from '../utils/scriptMetrics'

type ExamplesState = {
  examples: ExampleRecord[]
  importCount: number
}

type ExamplesAction =
  | { type: 'EXAMPLES_IMPORTED'; examples: ExampleRecord[] }
  | { type: 'EXAMPLE_DELETED'; id: string }
  | { type: 'EXAMPLE_TAGS_CHANGED'; id: string; tags: string[] }

const examplesReducer = (state: ExamplesState, action: ExamplesAction): ExamplesState => {
  switch (action.type) {
    case 'EXAMPLES_IMPORTED':
      return {
        examples: [...state.examples, ...action.examples],
        importCount: state.importCount + 1
      }
    case 'EXAMPLE_DELETED':
      return {
        ...state,
        examples: state.examples.filter(example => example.id !== action.id)
      }
    case 'EXAMPLE_TAGS_CHANGED':
      return {
        ...state,
        examples: state.examples.map(example =>
          example.id === action.id ? { ...example, tags: action.tags } : example
        )
      }
    default:
      return state
  }
}

interface UserExampleTagsFormProps {
  example: ExampleRecord
  onTagsSaved: (id: string, tags: string[]) => void
}

const UserExampleTagsForm = ({ example, onTagsSaved }: UserExampleTagsFormProps) => {
  const [tagText, setTagText] = useState(example.tags.join(', '))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onTagsSaved(example.id, parseTags(tagText))
  }

  return (
    <form
      className="example-tags-form"
      aria-label={`Edit tags for ${example.title}`}
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
      <button type="submit" aria-label={`Save tags for ${example.title}`}>
        <Check size={14} />
        Save tags
      </button>
    </form>
  )
}

export const ExamplesPage = () => {
  const [state, dispatch] = useReducer(
    examplesReducer,
    undefined,
    (): ExamplesState => ({ examples: getAllExamples(), importCount: 0 })
  )

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return

    const imported: ExampleRecord[] = []
    for (const file of files) {
      try {
        const text = await file.text()
        imported.push(importExampleFile(file.name, text))
      } catch (error) {
        console.error(`Failed to import example file ${file.name}:`, error)
      }
    }
    // Bumping importCount remounts the file input, clearing its selection
    dispatch({ type: 'EXAMPLES_IMPORTED', examples: imported })
  }

  const handleDelete = (example: ExampleRecord) => {
    if (confirm(`Delete the example "${example.title}"? This cannot be undone.`)) {
      deleteUserExample(example.id)
      dispatch({ type: 'EXAMPLE_DELETED', id: example.id })
    }
  }

  const handleTagsSaved = (id: string, tags: string[]) => {
    updateUserExampleTags(id, tags)
    dispatch({ type: 'EXAMPLE_TAGS_CHANGED', id, tags })
  }

  return (
    <section className="examples-page">
      <header>
        <h2>Example corpus</h2>
        <p>
          Generation is grounded in these scripts. Bundled examples ship with
          the app; your own imports and promoted scripts are stored in this
          browser and searched alongside them.
        </p>
      </header>

      <form className="example-import" aria-label="Import example scripts">
        <label htmlFor="example-import-input">Import markdown files as examples</label>
        <input
          key={state.importCount}
          id="example-import-input"
          type="file"
          accept=".md,.markdown,text/markdown"
          multiple
          onChange={handleImport}
        />
      </form>

      {state.examples.length === 0 ? (
        <p>No examples yet. Import a markdown file to get started.</p>
      ) : (
        <ul className="example-list">
          {state.examples.map(example => (
            <li key={example.id}>
              <div className="example-summary">
                <h3>{example.title}</h3>
                <p className="example-meta">
                  {example.source === 'bundled' ? 'Bundled · read-only' : 'Yours'}
                  {' · '}
                  {countWords(example.content).toLocaleString('en-US')} words
                  {example.source === 'bundled' && example.tags.length > 0 && (
                    <> · {example.tags.join(', ')}</>
                  )}
                </p>
                {example.source === 'user' && (
                  <UserExampleTagsForm
                    key={`${example.id}_${example.tags.join(',')}`}
                    example={example}
                    onTagsSaved={handleTagsSaved}
                  />
                )}
              </div>
              {example.source === 'user' && (
                <div className="example-actions">
                  <button
                    onClick={() => handleDelete(example)}
                    aria-label={`Delete example ${example.title}`}
                    type="button"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
