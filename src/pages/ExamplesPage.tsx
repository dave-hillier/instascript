import { useEffect, useReducer, useState } from 'react'
import { Trash2, Check } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import {
  applyExampleEnhancement,
  areBundledExamplesEnabled,
  backfillMissingEmbeddings,
  getAllExamples,
  getExampleSelectionCounts,
  getKnownTags,
  importExampleFile,
  isImportableExampleFile,
  deleteUserExample,
  setBundledExamplesEnabled,
  updateUserExampleTags,
  parseTags
} from '../services/exampleCorpus'
import {
  describeImportAssist,
  enhanceImportedExample,
  needsMarkdownFormatting,
  type ImportAssistOutcome
} from '../services/importAssist'
import {
  advanceImportFile,
  createImportProgress,
  describeImportOutcome,
  summarizeImportProgress,
  type ImportFileProgress,
  type ImportStage
} from '../services/importProgress'
import { ImportProgressMeter } from '../components/ImportProgressMeter'
import { createUtilityService } from '../services/serviceFactory'
import { isImportAssistEnabled } from '../services/config'
import { countWords } from '../utils/scriptMetrics'

// A file that made it into the corpus, kept paired with its meter row so the
// tidy pass can report which file each of its jobs is running for
type ImportedFile = {
  fileId: string
  example: ExampleRecord
}

// What the utility model made of the examples just imported (story 5.7).
// While it is working, the import meter names the job per file, so only the
// closing summary is held here.
type AssistState =
  | { status: 'idle' }
  | { status: 'finished'; outcome: ImportAssistOutcome; model: string }

type ExamplesState = {
  examples: ExampleRecord[]
  importCount: number
  bundledEnabled: boolean
  // The files of the most recent import and the stage each reached; the
  // summary counts are derived from these rather than tracked separately
  importFiles: ImportFileProgress[]
  assist: AssistState
}

type ExamplesAction =
  | { type: 'IMPORT_STARTED'; files: ImportFileProgress[] }
  | {
      type: 'IMPORT_FILE_STAGED'
      id: string
      stage: ImportStage
      note?: string
      exampleId?: string
    }
  | { type: 'EXAMPLES_IMPORTED'; examples: ExampleRecord[] }
  | { type: 'EXAMPLE_DELETED'; id: string }
  | { type: 'EXAMPLE_TAGS_CHANGED'; id: string; tags: string[] }
  | { type: 'BUNDLED_EXAMPLES_TOGGLED'; enabled: boolean }
  | { type: 'EXAMPLE_ASSISTED'; example: ExampleRecord | null }
  | { type: 'IMPORT_ASSIST_FINISHED'; outcome: ImportAssistOutcome; model: string }

const examplesReducer = (state: ExamplesState, action: ExamplesAction): ExamplesState => {
  switch (action.type) {
    case 'IMPORT_STARTED':
      return { ...state, importFiles: action.files, assist: { status: 'idle' } }
    case 'IMPORT_FILE_STAGED':
      return {
        ...state,
        importFiles: advanceImportFile(state.importFiles, action.id, action.stage, {
          note: action.note,
          exampleId: action.exampleId
        })
      }
    case 'EXAMPLE_ASSISTED': {
      const assisted = action.example
      if (!assisted) return state
      return {
        ...state,
        examples: state.examples.map(example =>
          example.id === assisted.id ? assisted : example
        )
      }
    }
    case 'IMPORT_ASSIST_FINISHED':
      return {
        ...state,
        assist: { status: 'finished', outcome: action.outcome, model: action.model }
      }
    case 'EXAMPLES_IMPORTED':
      return {
        ...state,
        examples: [...state.examples, ...action.examples],
        importCount: state.importCount + 1
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
      importFiles: [],
      assist: { status: 'idle' }
    })
  )
  const importSummary = summarizeImportProgress(state.importFiles)
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
    const selected = Array.from(event.target.files ?? [])
    if (selected.length === 0) return

    // Every selected file gets a row up front, so a folder import shows its
    // whole queue rather than growing a list as it goes
    const progress = createImportProgress(
      selected.map(file => file.webkitRelativePath || file.name)
    )
    dispatch({ type: 'IMPORT_STARTED', files: progress })

    const imported: ImportedFile[] = []
    for (const [index, file] of selected.entries()) {
      const { id, path } = progress[index]
      if (!isImportableExampleFile(path)) {
        dispatch({
          type: 'IMPORT_FILE_STAGED',
          id,
          stage: 'skipped',
          note: 'Not a markdown or text file'
        })
        continue
      }
      dispatch({ type: 'IMPORT_FILE_STAGED', id, stage: 'reading' })
      try {
        const text = await file.text()
        if (text.trim().length === 0) {
          dispatch({ type: 'IMPORT_FILE_STAGED', id, stage: 'skipped', note: 'Empty file' })
          continue
        }
        const example = importExampleFile(path, text)
        imported.push({ fileId: id, example })
        dispatch({
          type: 'IMPORT_FILE_STAGED',
          id,
          stage: 'saved',
          exampleId: example.id
        })
      } catch (error) {
        console.error(`Failed to import example file ${path}:`, error)
        dispatch({ type: 'IMPORT_FILE_STAGED', id, stage: 'failed', note: 'Could not be read' })
      }
    }
    // Bumping importCount remounts the file inputs, clearing their selection
    dispatch({ type: 'EXAMPLES_IMPORTED', examples: imported.map(entry => entry.example) })
    void runImportAssist(imported)
  }

  // Story 5.7: the small utility model tidies what was just imported —
  // markdown structure for a plain-text script, tags for an untagged one.
  // The examples are already saved and usable; this only improves them, so
  // it runs after the import reports success and never blocks it.
  const runImportAssist = async (imported: ImportedFile[]) => {
    const pending = isImportAssistEnabled()
      ? imported.filter(
          ({ example }) =>
            example.tags.length === 0 || needsMarkdownFormatting(example.content)
        )
      : []

    // Anything the tidy pass will not touch has finished its journey now
    const pendingFileIds = new Set(pending.map(entry => entry.fileId))
    for (const { fileId } of imported) {
      if (!pendingFileIds.has(fileId)) {
        dispatch({ type: 'IMPORT_FILE_STAGED', id: fileId, stage: 'done' })
      }
    }
    if (pending.length === 0) return

    const service = createUtilityService()
    const knownTags = getKnownTags()

    let tagged = 0
    let formatted = 0
    // Sequential: a folder import can be dozens of files, and a queue of
    // parallel requests to a rate-limited key fails more of them than it
    // finishes sooner
    for (const { fileId, example } of pending) {
      // The job names double as the meter's stages, so a file sitting on a
      // slow request says which request it is waiting on
      const enhancement = await enhanceImportedExample(example, service, knownTags, {
        onJobStarted: job =>
          dispatch({ type: 'IMPORT_FILE_STAGED', id: fileId, stage: job })
      })
      const updated =
        enhancement.tags || enhancement.content
          ? applyExampleEnhancement(example.id, enhancement)
          : null
      if (updated) {
        if (enhancement.tags) tagged += 1
        if (enhancement.content) formatted += 1
      }
      dispatch({ type: 'EXAMPLE_ASSISTED', example: updated })
      dispatch({ type: 'IMPORT_FILE_STAGED', id: fileId, stage: 'done' })
    }

    dispatch({
      type: 'IMPORT_ASSIST_FINISHED',
      outcome: { tagged, formatted },
      model: service.model
    })
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
          Generation is grounded in these scripts. Your imports and promoted
          scripts are stored in this browser. A small set of bundled
          placeholder examples ships with the app; they are off unless you
          switch them on.
        </p>
      </header>

      {!state.bundledEnabled && userExampleCount === 0 && (
        <p className="example-warning" role="status">
          You have no examples of your own yet, so generation has nothing to
          ground itself in. Import a markdown or text file below, promote a
          script you have written, or switch the bundled placeholder examples
          on.
        </p>
      )}

      <form className="example-settings" aria-label="Corpus settings">
        <label className="checkbox-field" htmlFor="bundled-examples">
          <input
            type="checkbox"
            id="bundled-examples"
            checked={state.bundledEnabled}
            onChange={event => handleBundledToggle(event.target.checked)}
            aria-describedby="bundled-examples-help"
          />
          <span>Also use the bundled placeholder examples</span>
        </label>
        <p id="bundled-examples-help">
          On means the bundled placeholder scripts are searched alongside your
          own. They are short stubs, so leaving them off keeps generation
          grounded only in material whose style you chose. Either way they stay
          listed below.
        </p>
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

        <ImportProgressMeter files={state.importFiles} />

        {importSummary.finished && (
          <p className="example-import-result" role="status" aria-live="polite">
            {describeImportOutcome(importSummary)}
          </p>
        )}

        {state.assist.status === 'finished' && (
          <p className="example-assist-result" role="status" aria-live="polite">
            {describeImportAssist(state.assist.outcome, state.assist.model) ||
              'The utility model found nothing to add to these imports.'}
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
