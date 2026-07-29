import { useEffect, useReducer, useState } from 'react'
import { Trash2, Check } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import {
  areBundledExamplesEnabled,
  backfillMissingEmbeddings,
  getAllExamples,
  getExampleSelectionCounts,
  importExampleFile,
  isImportableExampleFile,
  deleteUserExample,
  setBundledExamplesEnabled,
  updateUserExampleTags,
  parseTags
} from '../services/exampleCorpus'
import { countWords } from '../utils/scriptMetrics'

// What one import attempt did, for the status line
type ImportOutcome = {
  added: number
  skipped: number
  failed: number
}

type ExamplesState = {
  examples: ExampleRecord[]
  importCount: number
  bundledEnabled: boolean
  lastImport: ImportOutcome | null
}

type ExamplesAction =
  | { type: 'EXAMPLES_IMPORTED'; examples: ExampleRecord[]; skipped: number; failed: number }
  | { type: 'EXAMPLE_DELETED'; id: string }
  | { type: 'EXAMPLE_TAGS_CHANGED'; id: string; tags: string[] }
  | { type: 'BUNDLED_EXAMPLES_TOGGLED'; enabled: boolean }

const examplesReducer = (state: ExamplesState, action: ExamplesAction): ExamplesState => {
  switch (action.type) {
    case 'EXAMPLES_IMPORTED':
      return {
        ...state,
        examples: [...state.examples, ...action.examples],
        importCount: state.importCount + 1,
        lastImport: {
          added: action.examples.length,
          skipped: action.skipped,
          failed: action.failed
        }
      }
    case 'BUNDLED_EXAMPLES_TOGGLED':
      return { ...state, bundledEnabled: action.enabled }
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

// How often the example has actually informed a generation (story 8.11)
const describeSelectionCount = (count: number): string => {
  if (count === 0) return 'Never selected for a generation'
  return `Selected for ${count} ${count === 1 ? 'generation' : 'generations'}`
}

// Import feedback: folder imports routinely skip files, so say so plainly
const describeImport = ({ added, skipped, failed }: ImportOutcome): string => {
  const parts = [`Imported ${added} ${added === 1 ? 'example' : 'examples'}`]
  if (skipped > 0) parts.push(`skipped ${skipped} unsupported or empty ${skipped === 1 ? 'file' : 'files'}`)
  if (failed > 0) parts.push(`${failed} could not be read`)
  return `${parts.join(', ')}.`
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
    (): ExamplesState => ({
      examples: getAllExamples(),
      importCount: 0,
      bundledEnabled: areBundledExamplesEnabled(),
      lastImport: null
    })
  )
  const selectionCounts = getExampleSelectionCounts()
  const userExampleCount = state.examples.filter(example => example.source === 'user').length

  // Migration: examples saved before embeddings existed get theirs computed
  // once in the background; retrieval works without them in the meantime
  useEffect(() => {
    void backfillMissingEmbeddings()
  }, [])

  // Handles both single files and whole folders: a folder selection arrives
  // as its flattened contents, so anything that is not a markdown or text
  // file is skipped rather than imported as gibberish.
  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return

    const imported: ExampleRecord[] = []
    let skipped = 0
    let failed = 0
    for (const file of files) {
      const path = file.webkitRelativePath || file.name
      if (!isImportableExampleFile(path)) {
        skipped += 1
        continue
      }
      try {
        const text = await file.text()
        if (text.trim().length === 0) {
          skipped += 1
          continue
        }
        imported.push(importExampleFile(path, text))
      } catch (error) {
        console.error(`Failed to import example file ${path}:`, error)
        failed += 1
      }
    }
    // Bumping importCount remounts the file inputs, clearing their selection
    dispatch({ type: 'EXAMPLES_IMPORTED', examples: imported, skipped, failed })
  }

  const handleBundledToggle = (enabled: boolean) => {
    setBundledExamplesEnabled(enabled)
    dispatch({ type: 'BUNDLED_EXAMPLES_TOGGLED', enabled })
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
          the app and can be switched off; your own imports and promoted
          scripts are stored in this browser and searched alongside them.
        </p>
      </header>

      <form className="example-settings" aria-label="Corpus settings">
        <label className="checkbox-field" htmlFor="bundled-examples">
          <input
            type="checkbox"
            id="bundled-examples"
            checked={state.bundledEnabled}
            onChange={event => handleBundledToggle(event.target.checked)}
            aria-describedby="bundled-examples-help"
          />
          <span>Use bundled examples</span>
        </label>
        <p id="bundled-examples-help">
          Off means generation draws only on your own examples. The bundled
          scripts stay listed below, marked as excluded, so you can switch them
          back on at any time.
        </p>
        {!state.bundledEnabled && userExampleCount === 0 && (
          <p className="example-warning" role="status">
            You have no examples of your own, so generation currently has
            nothing to ground itself in. Import at least one, or switch the
            bundled examples back on.
          </p>
        )}
      </form>

      <form className="example-import" aria-label="Import example scripts">
        <label htmlFor="example-import-input">
          Import markdown or text files as examples
        </label>
        <input
          key={`files-${state.importCount}`}
          id="example-import-input"
          type="file"
          accept=".md,.markdown,.txt,.text,text/markdown,text/plain"
          multiple
          onChange={handleImport}
        />

        <label htmlFor="example-import-folder">Or import an entire folder</label>
        <input
          key={`folder-${state.importCount}`}
          id="example-import-folder"
          type="file"
          multiple
          onChange={handleImport}
          aria-describedby="example-import-folder-help"
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        />
        <p id="example-import-folder-help">
          Every markdown and text file in the folder and its subfolders is
          imported; anything else is skipped.
        </p>

        {state.lastImport && (
          <p className="example-import-result" role="status" aria-live="polite">
            {describeImport(state.lastImport)}
          </p>
        )}
      </form>

      {state.examples.length === 0 ? (
        <p>No examples yet. Import a markdown or text file to get started.</p>
      ) : (
        <ul className="example-list">
          {state.examples.map(example => (
            <li
              key={example.id}
              data-excluded={example.source === 'bundled' && !state.bundledEnabled}
            >
              <div className="example-summary">
                <h3>{example.title}</h3>
                <p className="example-meta">
                  {example.source === 'bundled'
                    ? state.bundledEnabled
                      ? 'Bundled · read-only'
                      : 'Bundled · excluded from generation'
                    : 'Yours'}
                  {' · '}
                  {countWords(example.content).toLocaleString('en-US')} words
                  {' · '}
                  {describeSelectionCount(selectionCounts[example.id] ?? 0)}
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
