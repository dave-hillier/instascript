import { useEffect, useReducer } from 'react'
import type { ExampleRecord } from '../types/example'
import {
  applyExampleEnhancement,
  areBundledExamplesEnabled,
  backfillMissingEmbeddings,
  deleteExampleFolder,
  exampleFolder,
  getActiveExampleFolder,
  getAllExamples,
  getExampleSelectionCounts,
  getKnownTags,
  importExampleFile,
  isImportableExampleFile,
  listExampleFolders,
  deleteUserExample,
  moveExampleToFolder,
  resolveActiveFolder,
  setActiveExampleFolder,
  setBundledExamplesEnabled,
  updateUserExampleTags
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
import { ExampleFolderSection } from '../components/ExampleFolderSection'
import { describeSelectionCount, FOLDER_SUGGESTIONS_ID } from '../utils/exampleDisplay'
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
  // The one folder retrieval draws on. Held in state and persisted on
  // change, so a folder disappearing (deleted, or emptied by moving its last
  // example) resolves to a folder that still exists.
  activeFolder: string
  // Folders the most recent import filed examples into, so an import that
  // landed outside the active folder can say so rather than appearing to
  // have done nothing
  importedFolders: string[]
  // The files of the most recent import and the stage each reached; the
  // summary counts are derived from these rather than tracked separately
  importFiles: ImportFileProgress[]
  // How many files of the most recent selection were not example files at
  // all. They get no row, so this is the one count the rows cannot derive.
  importIgnored: number
  assist: AssistState
}

type ExamplesAction =
  | { type: 'IMPORT_STARTED'; files: ImportFileProgress[]; ignored: number }
  | {
      type: 'IMPORT_FILE_STAGED'
      id: string
      stage: ImportStage
      note?: string
      exampleId?: string
    }
  | { type: 'EXAMPLES_IMPORTED'; examples: ExampleRecord[] }
  | { type: 'EXAMPLE_DELETED'; id: string }
  | { type: 'EXAMPLE_DETAILS_CHANGED'; id: string; tags: string[]; folder: string }
  | { type: 'FOLDER_ACTIVATED'; folder: string }
  | { type: 'FOLDER_DELETED'; folder: string }
  | { type: 'BUNDLED_EXAMPLES_TOGGLED'; enabled: boolean }
  | { type: 'EXAMPLE_ASSISTED'; example: ExampleRecord | null }
  | { type: 'IMPORT_ASSIST_FINISHED'; outcome: ImportAssistOutcome; model: string }

const userExamplesOf = (examples: ExampleRecord[]): ExampleRecord[] =>
  examples.filter(example => example.source === 'user')

// A folder selection knows where each file sat; a file chosen on its own has
// only its name
const importPathOf = (file: File): string => file.webkitRelativePath || file.name

// Any change to the corpus can remove the folder that was active; the active
// folder is re-resolved against what is left rather than tracked separately
const withExamples = (state: ExamplesState, examples: ExampleRecord[]): ExamplesState => ({
  ...state,
  examples,
  activeFolder: resolveActiveFolder(
    listExampleFolders(userExamplesOf(examples)),
    state.activeFolder
  )
})

const examplesReducer = (state: ExamplesState, action: ExamplesAction): ExamplesState => {
  switch (action.type) {
    case 'IMPORT_STARTED':
      return {
        ...state,
        importFiles: action.files,
        importIgnored: action.ignored,
        importedFolders: [],
        assist: { status: 'idle' }
      }
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
        ...withExamples(state, [...state.examples, ...action.examples]),
        importCount: state.importCount + 1,
        importedFolders: [...new Set(action.examples.map(exampleFolder))]
      }
    case 'BUNDLED_EXAMPLES_TOGGLED':
      return { ...state, bundledEnabled: action.enabled }
    case 'EXAMPLE_DELETED':
      return withExamples(
        state,
        state.examples.filter(example => example.id !== action.id)
      )
    case 'FOLDER_DELETED':
      return withExamples(
        state,
        state.examples.filter(
          example =>
            example.source !== 'user' || exampleFolder(example) !== action.folder
        )
      )
    case 'FOLDER_ACTIVATED':
      return { ...state, activeFolder: action.folder }
    case 'EXAMPLE_DETAILS_CHANGED':
      return withExamples(
        state,
        state.examples.map(example =>
          example.id === action.id
            ? { ...example, tags: action.tags, folder: action.folder }
            : example
        )
      )
    default:
      return state
  }
}

export const ExamplesPage = () => {
  const [state, dispatch] = useReducer(
    examplesReducer,
    undefined,
    (): ExamplesState => ({
      examples: getAllExamples(),
      importCount: 0,
      bundledEnabled: areBundledExamplesEnabled(),
      activeFolder: getActiveExampleFolder(),
      importedFolders: [],
      importFiles: [],
      importIgnored: 0,
      assist: { status: 'idle' }
    })
  )
  const importSummary = summarizeImportProgress(state.importFiles, state.importIgnored)
  const selectionCounts = getExampleSelectionCounts()
  const userExamples = userExamplesOf(state.examples)
  const bundledExamples = state.examples.filter(example => example.source === 'bundled')
  const folders = listExampleFolders(userExamples)
  const activeFolderExamples = userExamples.filter(
    example => exampleFolder(example) === state.activeFolder
  )
  // Where the last import landed, when that is not where generation is
  // looking — otherwise the import appears to have done nothing
  const idleFolders = state.importedFolders.filter(folder => folder !== state.activeFolder)

  // The active folder is a stored setting; the reducer resolves it, and this
  // writes each resolution back, including the one that follows deleting the
  // folder that was active
  useEffect(() => {
    setActiveExampleFolder(state.activeFolder)
  }, [state.activeFolder])

  // Migration: examples saved before embeddings existed get theirs computed
  // once in the background; retrieval works without them in the meantime
  useEffect(() => {
    void backfillMissingEmbeddings()
  }, [])

  // Handles both single files and whole folders: a folder selection arrives
  // as its flattened contents, so anything that is not a markdown or text
  // file is dropped rather than imported as gibberish.
  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? [])
    if (selected.length === 0) return

    // A folder arrives with its images, PDFs and dotfiles in tow. Those are
    // not part of the import, so they are counted aside rather than queued —
    // the meter measures the work being done, not the size of the folder.
    const importable = selected.filter(file =>
      isImportableExampleFile(importPathOf(file))
    )
    const ignored = selected.length - importable.length

    // Every file being imported gets a row up front, so a folder import shows
    // its whole queue rather than growing a list as it goes
    const progress = createImportProgress(importable.map(importPathOf))
    dispatch({ type: 'IMPORT_STARTED', files: progress, ignored })

    const imported: ImportedFile[] = []
    for (const [index, file] of importable.entries()) {
      const { id, path } = progress[index]
      dispatch({ type: 'IMPORT_FILE_STAGED', id, stage: 'reading' })
      try {
        const text = await file.text()
        if (text.trim().length === 0) {
          dispatch({ type: 'IMPORT_FILE_STAGED', id, stage: 'skipped', note: 'Empty file' })
          continue
        }
        // A folder import files each script under the folder it came from;
        // files chosen on their own join the folder in use, so they are
        // available to the next generation without being filed first
        const example = importExampleFile(path, text, state.activeFolder)
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

  const handleFolderDelete = (folder: string) => {
    const count = userExamples.filter(example => exampleFolder(example) === folder).length
    const subject = count === 1 ? 'its 1 example' : `all ${count} of its examples`
    if (confirm(`Delete the folder "${folder}" and ${subject}? This cannot be undone.`)) {
      deleteExampleFolder(folder)
      dispatch({ type: 'FOLDER_DELETED', folder })
    }
  }

  const handleFolderActivated = (folder: string) => {
    dispatch({ type: 'FOLDER_ACTIVATED', folder })
  }

  const handleDetailsSaved = (
    id: string,
    details: { tags: string[]; folder: string }
  ) => {
    updateUserExampleTags(id, details.tags)
    const folder = moveExampleToFolder(id, details.folder)
    dispatch({ type: 'EXAMPLE_DETAILS_CHANGED', id, tags: details.tags, folder })
  }

  return (
    <section className="examples-page">
      <header>
        <h2>Example corpus</h2>
        <p>
          Generation is grounded in these scripts. Your imports and promoted
          scripts are stored in this browser, filed into folders — one folder
          at a time grounds generation, so you can keep several bodies of
          material and switch between them. A small set of bundled placeholder
          examples ships with the app; they are off unless you switch them on.
        </p>
      </header>

      {!state.bundledEnabled && activeFolderExamples.length === 0 && (
        <p className="example-warning" role="status">
          {userExamples.length === 0
            ? 'You have no examples of your own yet, so generation has nothing to ground itself in. Import a markdown or text file below, promote a script you have written, or switch the bundled placeholder examples on.'
            : `The folder generation is using, "${state.activeFolder}", is empty, so generation has nothing to ground itself in. Choose a folder that has examples in it, or switch the bundled placeholder examples on.`}
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
          On means the bundled placeholder scripts are searched alongside the
          folder in use. They are short stubs, so leaving them off keeps
          generation grounded only in material whose style you chose. Either
          way they stay listed below.
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
          aria-describedby="example-import-files-help"
        />
        <p id="example-import-files-help">
          Files chosen this way join "{state.activeFolder}", the folder
          generation is currently using.
        </p>

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
          imported; anything else is ignored. Each script is filed under the
          folder it sits in, so a folder of categorised subfolders arrives as
          one corpus folder per subfolder.
        </p>

        <ImportProgressMeter files={state.importFiles} />

        {importSummary.finished && (
          <p className="example-import-result" role="status" aria-live="polite">
            {describeImportOutcome(importSummary)}
          </p>
        )}

        {importSummary.finished && idleFolders.length > 0 && (
          <p className="example-import-elsewhere" role="status" aria-live="polite">
            {idleFolders.length === 1
              ? `These went into "${idleFolders[0]}", which is not the folder generation is using.`
              : `These went into folders other than the one generation is using: ${idleFolders.join(', ')}.`}
            {idleFolders.map(folder => (
              <button
                key={folder}
                type="button"
                onClick={() => handleFolderActivated(folder)}
              >
                Use "{folder}" for generation
              </button>
            ))}
          </p>
        )}

        {state.assist.status === 'finished' && (
          <p className="example-assist-result" role="status" aria-live="polite">
            {describeImportAssist(state.assist.outcome, state.assist.model) ||
              'The utility model found nothing to add to these imports.'}
          </p>
        )}
      </form>

      <datalist id={FOLDER_SUGGESTIONS_ID}>
        {folders.map(folder => (
          <option key={folder} value={folder} />
        ))}
      </datalist>

      {userExamples.length === 0 ? (
        <p>No examples of your own yet. Import a markdown or text file to get started.</p>
      ) : (
        folders.map((folder, index) => (
          <ExampleFolderSection
            key={folder}
            folder={folder}
            headingId={`example-folder-${index}`}
            examples={userExamples.filter(example => exampleFolder(example) === folder)}
            active={folder === state.activeFolder}
            selectionCounts={selectionCounts}
            onActivated={handleFolderActivated}
            onFolderDeleted={handleFolderDelete}
            onExampleDeleted={handleDelete}
            onDetailsSaved={handleDetailsSaved}
          />
        ))
      )}

      {bundledExamples.length > 0 && (
        <section
          className="example-folder"
          aria-labelledby="bundled-examples-heading"
          data-active={state.bundledEnabled}
        >
          <header>
            <h3 id="bundled-examples-heading">Bundled placeholder examples</h3>
            <p className="example-folder-meta">
              {bundledExamples.length} examples · read-only ·{' '}
              {state.bundledEnabled
                ? 'searched alongside the folder in use'
                : 'excluded from generation'}
            </p>
          </header>
          <ul className="example-list">
            {bundledExamples.map(example => (
              <li key={example.id} data-excluded={!state.bundledEnabled}>
                <div className="example-summary">
                  <h4>{example.title}</h4>
                  <p className="example-meta">
                    {countWords(example.content).toLocaleString('en-US')} words
                    {' · '}
                    {describeSelectionCount(selectionCounts[example.id] ?? 0)}
                    {example.tags.length > 0 && <> · {example.tags.join(', ')}</>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
