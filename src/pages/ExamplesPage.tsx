import { useEffect, useReducer, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookmarkPlus } from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import {
  applyExampleEnhancement,
  applyTranscriptSplit,
  areBundledExamplesEnabled,
  backfillMissingEmbeddings,
  createExampleFolder,
  deleteExampleFolder,
  exampleFolder,
  getActiveExampleFolder,
  getAllExamples,
  getDeclaredFolders,
  getExampleSelectionCounts,
  getKnownTags,
  importExampleFile,
  isImportableExampleFile,
  listExampleFolders,
  deleteUserExample,
  moveExampleToFolder,
  promoteScriptToExample,
  renameExampleFolder,
  resolveActiveFolder,
  setActiveExampleFolder,
  setBundledExamplesEnabled,
  UNFILED_FOLDER,
  updateUserExampleTags
} from '../services/exampleCorpus'
import {
  describeImportAssist,
  enhanceImportedExample,
  importAssistJobsFor,
  rewriteForDirectAddress,
  type ImportAssistOutcome
} from '../services/importAssist'
import {
  cleanUpExample,
  createCleanupProgress,
  describeCleanupOutcome,
  EMPTY_CLEANUP_OUTCOME,
  isEmptyCleanup,
  recordCleanup,
  type CleanupOutcome
} from '../services/exampleCleanup'
import { adoptExampleAsScript } from '../services/exampleToScript'
import {
  describePromotableScript,
  listPromotableScripts,
  type PromotableScript
} from '../services/scriptToExample'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import {
  advanceImportFile,
  createImportProgress,
  describeImportOutcome,
  summarizeImportProgress,
  type ImportFileProgress,
  type ImportStage
} from '../services/importProgress'
import {
  describeTranscriptImport,
  renderSplitContent,
  splitSpecs,
  splitTranscript,
  type TranscriptImportOutcome
} from '../services/transcriptImport'
import { ImportProgressMeter } from '../components/ImportProgressMeter'
import { ExampleFolderRail } from '../components/ExampleFolderRail'
import {
  BundledFolderView,
  ExampleFolderView
} from '../components/ExampleFolderView'
import { createUtilityService } from '../services/serviceFactory'
import {
  isImportAssistEnabled,
  isImportVoicingEnabled,
  setImportVoicingEnabled
} from '../services/config'

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

// The outcome of saving a library script into the corpus, so the page can
// say where it went — and whether it replaced the copy already held for that
// script rather than adding a second one
type PromotionState =
  | { status: 'idle' }
  | { status: 'saved'; title: string; folder: string; replaced: boolean }

// The on-demand direct-address rewrite of one example already in the corpus:
// which one is running, and what came of the last one
type RewriteState = {
  runningId: string | null
  note: string | null
}

// What the utility model made of a transcript import. Like the tidy pass, the
// per-file stages are on the meter, so only the closing summary is held here —
// plus the one state the meter cannot express, a provider that is not there.
type SplitState =
  | { status: 'idle' }
  | { status: 'unavailable' }
  | { status: 'finished'; outcome: TranscriptImportOutcome; model: string }

// The clean-up pass (story 8.19) over examples already in the corpus. It runs
// one folder at a time and reports through the import meter, so what is held
// here is which folder's meter is on screen, whether it is still going, and
// the line it finished on.
type CleanupState = {
  folder: string | null
  running: boolean
  files: ImportFileProgress[]
  note: string | null
}

// Which folder the listing is showing. Browsing a folder is not choosing it:
// the folder generation draws on is `activeFolder`, and this is only where
// the eye is — including on the bundled set, which is browsed but never
// filed into.
type ExamplesView = { kind: 'folder'; folder: string } | { kind: 'bundled' }

type ExamplesState = {
  examples: ExampleRecord[]
  view: ExamplesView
  importCount: number
  bundledEnabled: boolean
  // The one folder retrieval draws on. Held in state and persisted on
  // change, so a folder disappearing (deleted, or emptied by moving its last
  // example) resolves to a folder that still exists.
  activeFolder: string
  // Folders the user has made, which exist whether or not anything is filed
  // in them yet
  declaredFolders: string[]
  // Where the next import goes: a folder name, or '' for the folder each
  // file came from
  importDestination: string
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
  // Whether an import also rewrites third person and titles of address into
  // direct address. A stored setting, chosen here because it is a property of
  // the import rather than of the app.
  importVoicing: boolean
  assist: AssistState
  promotion: PromotionState
  rewrite: RewriteState
  split: SplitState
  cleanup: CleanupState
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
  | { type: 'FOLDER_VIEWED'; folder: string }
  | { type: 'BUNDLED_VIEWED' }
  | { type: 'FOLDER_CREATED'; folder: string }
  | { type: 'FOLDER_RENAMED'; from: string; to: string }
  | { type: 'FOLDER_DELETED'; folder: string }
  | { type: 'IMPORT_DESTINATION_CHANGED'; folder: string }
  | { type: 'BUNDLED_EXAMPLES_TOGGLED'; enabled: boolean }
  | { type: 'EXAMPLE_ASSISTED'; example: ExampleRecord | null }
  | { type: 'IMPORT_ASSIST_FINISHED'; outcome: ImportAssistOutcome; model: string }
  | { type: 'IMPORT_VOICING_TOGGLED'; enabled: boolean }
  | { type: 'SCRIPT_SAVED_AS_EXAMPLE'; example: ExampleRecord; replaced: boolean }
  | { type: 'EXAMPLE_REWRITE_STARTED'; id: string }
  | { type: 'EXAMPLE_REWRITE_FINISHED'; example: ExampleRecord | null; note: string }
  | { type: 'TRANSCRIPT_SPLIT_UNAVAILABLE' }
  | { type: 'TRANSCRIPT_SPLIT_FINISHED'; outcome: TranscriptImportOutcome; model: string }
  | { type: 'CLEANUP_STARTED'; folder: string; files: ImportFileProgress[] }
  | { type: 'CLEANUP_STAGED'; id: string; stage: ImportStage }
  | { type: 'CLEANUP_FINISHED'; note: string }

const userExamplesOf = (examples: ExampleRecord[]): ExampleRecord[] =>
  examples.filter(example => example.source === 'user')

// A folder selection knows where each file sat; a file chosen on its own has
// only its name
const importPathOf = (file: File): string => file.webkitRelativePath || file.name

// Emptying a folder is not deleting it: a folder an example leaves (or was
// the last one in) is recorded so it stays on the page, matching what the
// corpus stores. Only Delete folder takes one away.
const declaredWith = (declared: string[], ...names: string[]): string[] => [
  ...declared,
  ...names.filter(name => name !== UNFILED_FOLDER && !declared.includes(name))
]

// Any change to the corpus can remove the folder that was active — deleted,
// renamed, or emptied and never declared. The active folder and the import
// destination are re-resolved against what is left rather than tracked
// separately, so neither can point at a folder that is gone.
const withCorpus = (
  state: ExamplesState,
  examples: ExampleRecord[],
  declaredFolders: string[] = state.declaredFolders
): ExamplesState => {
  const folders = listExampleFolders(userExamplesOf(examples), declaredFolders)
  const activeFolder = resolveActiveFolder(folders, state.activeFolder)
  return {
    ...state,
    examples,
    declaredFolders,
    activeFolder,
    // The listing follows the same rule: a folder that is gone falls back to
    // the one grounding generation rather than showing an empty listing for
    // a folder that no longer exists
    view:
      state.view.kind === 'folder' && !folders.includes(state.view.folder)
        ? { kind: 'folder', folder: activeFolder }
        : state.view,
    importDestination: folders.includes(state.importDestination)
      ? state.importDestination
      : ''
  }
}

const examplesReducer = (state: ExamplesState, action: ExamplesAction): ExamplesState => {
  switch (action.type) {
    case 'IMPORT_STARTED':
      return {
        ...state,
        importFiles: action.files,
        importIgnored: action.ignored,
        importedFolders: [],
        assist: { status: 'idle' },
        split: { status: 'idle' }
      }
    case 'TRANSCRIPT_SPLIT_UNAVAILABLE':
      return { ...state, split: { status: 'unavailable' } }
    case 'TRANSCRIPT_SPLIT_FINISHED':
      return {
        ...state,
        split: { status: 'finished', outcome: action.outcome, model: action.model }
      }
    case 'IMPORT_FILE_STAGED':
      return {
        ...state,
        importFiles: advanceImportFile(state.importFiles, action.id, action.stage, {
          note: action.note,
          exampleId: action.exampleId
        })
      }
    case 'CLEANUP_STARTED':
      return {
        ...state,
        cleanup: {
          folder: action.folder,
          running: true,
          files: action.files,
          note: null
        }
      }
    case 'CLEANUP_STAGED':
      return {
        ...state,
        cleanup: {
          ...state.cleanup,
          files: advanceImportFile(state.cleanup.files, action.id, action.stage)
        }
      }
    case 'CLEANUP_FINISHED':
      return {
        ...state,
        cleanup: { ...state.cleanup, running: false, note: action.note }
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
    case 'IMPORT_VOICING_TOGGLED':
      return { ...state, importVoicing: action.enabled }
    case 'EXAMPLE_REWRITE_STARTED':
      return { ...state, rewrite: { runningId: action.id, note: null } }
    case 'EXAMPLE_REWRITE_FINISHED': {
      const rewritten = action.example
      return {
        ...state,
        examples: rewritten
          ? state.examples.map(example =>
              example.id === rewritten.id ? rewritten : example
            )
          : state.examples,
        rewrite: { runningId: null, note: action.note }
      }
    }
    case 'SCRIPT_SAVED_AS_EXAMPLE': {
      const saved = action.example
      const examples = action.replaced
        ? state.examples.map(example => (example.id === saved.id ? saved : example))
        : [...state.examples, saved]
      return {
        ...withCorpus(
          state,
          examples,
          declaredWith(state.declaredFolders, exampleFolder(saved))
        ),
        promotion: {
          status: 'saved',
          title: saved.title,
          folder: exampleFolder(saved),
          replaced: action.replaced
        }
      }
    }
    case 'EXAMPLES_IMPORTED': {
      const arrivedIn = [...new Set(action.examples.map(exampleFolder))]
      return {
        ...withCorpus(
          state,
          [...state.examples, ...action.examples],
          declaredWith(state.declaredFolders, ...arrivedIn)
        ),
        importCount: state.importCount + 1,
        importedFolders: arrivedIn
      }
    }
    case 'BUNDLED_EXAMPLES_TOGGLED':
      return { ...state, bundledEnabled: action.enabled }
    case 'EXAMPLE_DELETED': {
      const deleted = state.examples.find(example => example.id === action.id)
      return withCorpus(
        state,
        state.examples.filter(example => example.id !== action.id),
        deleted
          ? declaredWith(state.declaredFolders, exampleFolder(deleted))
          : state.declaredFolders
      )
    }
    case 'FOLDER_DELETED':
      return withCorpus(
        state,
        state.examples.filter(
          example =>
            example.source !== 'user' || exampleFolder(example) !== action.folder
        ),
        state.declaredFolders.filter(folder => folder !== action.folder)
      )
    case 'FOLDER_CREATED':
      // A folder is made to put something in, so the listing opens it
      return withCorpus(
        { ...state, view: { kind: 'folder', folder: action.folder } },
        state.examples,
        [
          ...state.declaredFolders.filter(folder => folder !== action.folder),
          action.folder
        ]
      )
    case 'FOLDER_RENAMED': {
      // The active folder follows its own rename, so generation keeps
      // drawing on the material it was drawing on
      const renamed =
        state.activeFolder === action.from ? action.to : state.activeFolder
      // The listing follows a rename too, so the folder stays open under its
      // new name rather than falling back to another folder
      const viewed: ExamplesView =
        state.view.kind === 'folder' && state.view.folder === action.from
          ? { kind: 'folder', folder: action.to }
          : state.view
      return withCorpus(
        { ...state, activeFolder: renamed, view: viewed },
        state.examples.map(example =>
          example.source === 'user' && exampleFolder(example) === action.from
            ? { ...example, folder: action.to }
            : example
        ),
        [
          ...state.declaredFolders.filter(
            folder => folder !== action.from && folder !== action.to
          ),
          action.to
        ]
      )
    }
    case 'FOLDER_ACTIVATED':
      return { ...state, activeFolder: action.folder }
    case 'FOLDER_VIEWED':
      return { ...state, view: { kind: 'folder', folder: action.folder } }
    case 'BUNDLED_VIEWED':
      return { ...state, view: { kind: 'bundled' } }
    case 'IMPORT_DESTINATION_CHANGED':
      return { ...state, importDestination: action.folder }
    case 'EXAMPLE_DETAILS_CHANGED': {
      const moved = state.examples.find(example => example.id === action.id)
      return withCorpus(
        state,
        state.examples.map(example =>
          example.id === action.id
            ? { ...example, tags: action.tags, folder: action.folder }
            : example
        ),
        declaredWith(
          state.declaredFolders,
          ...(moved ? [exampleFolder(moved)] : []),
          action.folder
        )
      )
    }
    default:
      return state
  }
}

// The corpus's other source of material: the scripts already in the library.
// A script and an example are the same text at two points in one loop, so
// saving one into the corpus is a first-class way of filling it rather than
// something only reachable from the script that happens to be open.
const LibraryPromotionForm = ({
  scripts,
  folders,
  defaultFolder,
  onPromote
}: {
  scripts: PromotableScript[]
  folders: string[]
  defaultFolder: string
  onPromote: (entry: PromotableScript, folder: string) => void
}) => {
  const [scriptId, setScriptId] = useState('')
  const [folder, setFolder] = useState(defaultFolder)
  const selected = scripts.find(entry => entry.script.id === scriptId) ?? scripts[0]

  if (scripts.length === 0) {
    return (
      <section className="example-from-library" aria-labelledby="from-library-heading">
        <h3 id="from-library-heading">From your script library</h3>
        <p>
          Nothing in your library to save yet. A script you have generated —
          or one you opened from an example and reworked — can be saved back
          here as an example.
        </p>
      </section>
    )
  }

  return (
    <form
      className="example-from-library"
      aria-labelledby="from-library-heading"
      onSubmit={event => {
        event.preventDefault()
        if (selected) onPromote(selected, folder)
      }}
    >
      <h3 id="from-library-heading">From your script library</h3>
      <p>
        A script you have written can ground the next generation. Saving a
        script you already saved brings its example up to date rather than
        adding a second copy.
      </p>

      <label htmlFor="promote-script">Script</label>
      <select
        id="promote-script"
        value={selected?.script.id ?? ''}
        onChange={event => setScriptId(event.target.value)}
      >
        {scripts.map(entry => (
          <option key={entry.script.id} value={entry.script.id}>
            {describePromotableScript(entry)}
          </option>
        ))}
      </select>

      <label htmlFor="promote-folder">Folder</label>
      <select
        id="promote-folder"
        value={folder}
        onChange={event => setFolder(event.target.value)}
        disabled={!!selected?.savedExampleId}
        aria-describedby="promote-folder-help"
      >
        {folders.map(name => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <p id="promote-folder-help">
        {selected?.savedExampleId
          ? `Already saved in "${selected.savedFolder ?? UNFILED_FOLDER}". Saving again updates it there; move it from its own row to file it elsewhere.`
          : 'Where the example is filed. Files it into the folder generation is using unless you choose another.'}
      </p>

      <button type="submit">
        <BookmarkPlus size={14} />
        {selected?.savedExampleId ? 'Update the saved example' : 'Save as example'}
      </button>
    </form>
  )
}

export const ExamplesPage = () => {
  const navigate = useNavigate()
  const { state: appState, dispatch: appDispatch } = useAppContext()
  const { state: conversationState, adoptConversation } = useConversationContext()
  const [state, dispatch] = useReducer(
    examplesReducer,
    undefined,
    (): ExamplesState => ({
      examples: getAllExamples(),
      // The listing opens on the folder grounding generation: it is the one
      // the rest of the app is using, so it is the one worth seeing first
      view: { kind: 'folder', folder: getActiveExampleFolder() },
      importCount: 0,
      bundledEnabled: areBundledExamplesEnabled(),
      activeFolder: getActiveExampleFolder(),
      declaredFolders: getDeclaredFolders(),
      importDestination: '',
      importedFolders: [],
      importFiles: [],
      importIgnored: 0,
      importVoicing: isImportVoicingEnabled(),
      assist: { status: 'idle' },
      promotion: { status: 'idle' },
      rewrite: { runningId: null, note: null },
      split: { status: 'idle' },
      cleanup: { folder: null, running: false, files: [], note: null }
    })
  )
  const importSummary = summarizeImportProgress(state.importFiles, state.importIgnored)
  const selectionCounts = getExampleSelectionCounts()
  const userExamples = userExamplesOf(state.examples)
  const bundledExamples = state.examples.filter(example => example.source === 'bundled')
  const folders = listExampleFolders(userExamples, state.declaredFolders)
  // Unfiled is offered as somewhere to move an example even when nothing is
  // unfiled: it is how an example is taken out of a folder
  const folderOptions = folders.includes(UNFILED_FOLDER)
    ? folders
    : [...folders, UNFILED_FOLDER]
  const activeFolderExamples = userExamples.filter(
    example => exampleFolder(example) === state.activeFolder
  )
  // The folder the listing is showing, null while the bundled set is. A
  // stored folder that has since gone falls back to the one grounding
  // generation, the same way the reducer resolves it.
  const viewedFolder =
    state.view.kind === 'bundled'
      ? null
      : folders.includes(state.view.folder)
        ? state.view.folder
        : folders.includes(state.activeFolder)
          ? state.activeFolder
          : (folders[0] ?? null)
  const railFolders = folders.map(folder => ({
    name: folder,
    count: userExamples.filter(example => exampleFolder(example) === folder).length,
    grounding: folder === state.activeFolder
  }))
  // Where the last import landed, when that is not where generation is
  // looking — otherwise the import appears to have done nothing
  const idleFolders = state.importedFolders.filter(folder => folder !== state.activeFolder)
  // The library scripts worth offering to the corpus, and which of them it
  // already holds an example for
  const promotableScripts = listPromotableScripts(
    appState.scripts,
    conversationState.conversations,
    userExamples
  )

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
  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) =>
    runImport(event, 'script')

  // Transcripts take the same route into the corpus — read, saved, then handed
  // to the utility model — with one extra pass in front of the tidy jobs
  const handleTranscriptImport = (event: React.ChangeEvent<HTMLInputElement>) =>
    runImport(event, 'transcript')

  const runImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
    kind: 'script' | 'transcript'
  ) => {
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
        // A chosen destination takes every file in the import. Without one,
        // a folder import files each script under the folder it came from,
        // and files chosen on their own join the folder in use — so they are
        // available to the next generation without being filed first.
        const example = importExampleFile(path, text, {
          folder: state.importDestination,
          fallback: state.activeFolder
        })
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
    void runPostImport(imported, kind)
  }

  // The passes that run after the files are safely in the corpus. A transcript
  // is split first, so the tidy pass that follows sees the sectioned script
  // rather than the raw recording.
  const runPostImport = async (imported: ImportedFile[], kind: 'script' | 'transcript') => {
    const ready = kind === 'transcript' ? await runTranscriptSplit(imported) : imported
    await runImportAssist(ready)
  }

  // The transcript pass: the utility model finds where each session turns and
  // returns it as sections, each with a spec and the words spoken in it. A
  // transcript it cannot split stays in the corpus as it was imported.
  const runTranscriptSplit = async (imported: ImportedFile[]): Promise<ImportedFile[]> => {
    if (imported.length === 0 || !isImportAssistEnabled()) return imported

    const service = createUtilityService()
    if (!service.isLive) {
      dispatch({ type: 'TRANSCRIPT_SPLIT_UNAVAILABLE' })
      return imported
    }

    let split = 0
    let kept = 0
    const result: ImportedFile[] = []
    // Sequential for the same reason the tidy pass is: a split repeats the
    // whole transcript back, so these are the longest requests the app makes
    for (const entry of imported) {
      const { fileId, example } = entry
      dispatch({ type: 'IMPORT_FILE_STAGED', id: fileId, stage: 'splitting' })

      const parsed = await splitTranscript(example.title, example.content, service)
      if (!parsed) {
        kept += 1
        result.push(entry)
        continue
      }

      const updated = applyTranscriptSplit(example.id, {
        title: parsed.title,
        content: renderSplitContent(parsed),
        sections: splitSpecs(parsed)
      })
      if (!updated) {
        kept += 1
        result.push(entry)
        continue
      }

      split += 1
      dispatch({ type: 'EXAMPLE_ASSISTED', example: updated })
      result.push({ fileId, example: updated })
    }

    dispatch({
      type: 'TRANSCRIPT_SPLIT_FINISHED',
      outcome: { split, kept },
      model: service.model
    })
    return result
  }

  // Story 5.7: the small utility model tidies what was just imported —
  // markdown structure for a plain-text script, tags for an untagged one.
  // The examples are already saved and usable; this only improves them, so
  // it runs after the import reports success and never blocks it.
  const runImportAssist = async (imported: ImportedFile[]) => {
    const pending = isImportAssistEnabled()
      ? imported.filter(
          ({ example }) =>
            importAssistJobsFor(example, { voicing: state.importVoicing }).length > 0
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
    let voiced = 0
    // Sequential: a folder import can be dozens of files, and a queue of
    // parallel requests to a rate-limited key fails more of them than it
    // finishes sooner
    for (const { fileId, example } of pending) {
      // The job names double as the meter's stages, so a file sitting on a
      // slow request says which request it is waiting on
      const enhancement = await enhanceImportedExample(example, service, knownTags, {
        voicing: state.importVoicing,
        onJobStarted: job =>
          dispatch({ type: 'IMPORT_FILE_STAGED', id: fileId, stage: job })
      })
      const updated =
        enhancement.tags || enhancement.content
          ? applyExampleEnhancement(example.id, enhancement)
          : null
      if (updated) {
        if (enhancement.tags) tagged += 1
        if (enhancement.formatted) formatted += 1
        if (enhancement.voiced) voiced += 1
      }
      dispatch({ type: 'EXAMPLE_ASSISTED', example: updated })
      dispatch({ type: 'IMPORT_FILE_STAGED', id: fileId, stage: 'done' })
    }

    dispatch({
      type: 'IMPORT_ASSIST_FINISHED',
      outcome: { tagged, formatted, voiced },
      model: service.model
    })
  }

  // The same rewrite the import offers, run on an example already in the
  // corpus — most material was imported before the option existed, and it is
  // worth being able to fix in place rather than only on the way in
  const handleRewriteExample = async (example: ExampleRecord) => {
    dispatch({ type: 'EXAMPLE_REWRITE_STARTED', id: example.id })
    const service = createUtilityService()
    if (!service.isLive) {
      dispatch({
        type: 'EXAMPLE_REWRITE_FINISHED',
        example: null,
        note: 'The rewrite needs a configured provider — the mock cannot rewrite a script.'
      })
      return
    }

    const voiced = await rewriteForDirectAddress(example.content, service)
    if (!voiced) {
      dispatch({
        type: 'EXAMPLE_REWRITE_FINISHED',
        example: null,
        note: `${service.model} did not return a usable rewrite of "${example.title}", so it is unchanged.`
      })
      return
    }

    const updated = applyExampleEnhancement(example.id, { content: voiced })
    dispatch({
      type: 'EXAMPLE_REWRITE_FINISHED',
      example: updated,
      note: updated
        ? `${service.model} rewrote "${updated.title}" into direct address.`
        : `"${example.title}" is no longer in the corpus.`
    })
  }

  // Story 8.19: the tidy pass, run on demand over material already in the
  // corpus rather than only on the way in. The examples are usable as they
  // stand; this only improves them, so an unreachable model or an unusable
  // reply leaves each one exactly as it was.
  const handleCleanUp = async (folder: string, targets: ExampleRecord[]) => {
    if (state.cleanup.running || targets.length === 0) return
    const files = createCleanupProgress(targets)
    dispatch({ type: 'CLEANUP_STARTED', folder, files })

    const service = createUtilityService()
    if (!service.isLive) {
      dispatch({
        type: 'CLEANUP_FINISHED',
        note: 'Cleaning up needs a configured provider — the mock cannot title, section or tag a script.'
      })
      return
    }

    const knownTags = getKnownTags()
    let outcome: CleanupOutcome = EMPTY_CLEANUP_OUTCOME
    // Sequential for the same reason the import passes are: a folder can be
    // dozens of examples, and a queue of parallel requests to a rate-limited
    // key fails more of them than it finishes sooner
    for (const example of targets) {
      const cleanup = await cleanUpExample(example, service, knownTags, {
        onJobStarted: job => dispatch({ type: 'CLEANUP_STAGED', id: example.id, stage: job })
      })
      if (!isEmptyCleanup(cleanup)) {
        dispatch({
          type: 'EXAMPLE_ASSISTED',
          example: applyExampleEnhancement(example.id, cleanup)
        })
      }
      outcome = recordCleanup(outcome, cleanup)
      dispatch({ type: 'CLEANUP_STAGED', id: example.id, stage: 'done' })
    }

    dispatch({
      type: 'CLEANUP_FINISHED',
      note:
        describeCleanupOutcome(outcome, service.model) ||
        `${service.model} found nothing to change.`
    })
  }

  // Corpus to library: the example is reconstructed as a script — an outline
  // and its sections — so everything the script page does works on it. The
  // script is a copy from here on; editing it never writes back.
  const handleOpenAsScript = (example: ExampleRecord) => {
    const scriptId = `script_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const { script, generations } = adoptExampleAsScript(example, scriptId)
    const conversation = adoptConversation(scriptId, generations)
    appDispatch({ type: 'ADD_SCRIPT', script: { ...script, conversationId: conversation.id } })
    navigate(`/script/${scriptId}`)
  }

  // Library to corpus: the script as it currently stands, consolidated from
  // its conversation, saved as an example
  const handlePromoteScript = (entry: PromotableScript, folder: string) => {
    const example = promoteScriptToExample({
      title: entry.script.title,
      content: entry.content,
      tags: entry.script.tags ?? [],
      folder,
      scriptId: entry.script.id
    })
    dispatch({
      type: 'SCRIPT_SAVED_AS_EXAMPLE',
      example,
      replaced: !!entry.savedExampleId
    })
  }

  const handleVoicingToggle = (enabled: boolean) => {
    setImportVoicingEnabled(enabled)
    dispatch({ type: 'IMPORT_VOICING_TOGGLED', enabled })
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
    const question =
      count === 0
        ? `Delete the empty folder "${folder}"?`
        : `Delete the folder "${folder}" and ${count === 1 ? 'its 1 example' : `all ${count} of its examples`}? This cannot be undone.`
    if (confirm(question)) {
      deleteExampleFolder(folder)
      dispatch({ type: 'FOLDER_DELETED', folder })
    }
  }

  const handleFolderActivated = (folder: string) => {
    dispatch({ type: 'FOLDER_ACTIVATED', folder })
  }

  const handleFolderCreated = (name: string) => {
    const folder = createExampleFolder(name)
    if (!folder) return
    dispatch({ type: 'FOLDER_CREATED', folder })
    // A folder is made to put something in, so the next import goes there
    dispatch({ type: 'IMPORT_DESTINATION_CHANGED', folder })
  }

  const handleFolderRenamed = (from: string, to: string) => {
    const renamed = renameExampleFolder(from, to)
    dispatch({ type: 'FOLDER_RENAMED', from, to: renamed })
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
          Generation is grounded in one folder of these scripts at a time.
          Everything here is kept in this browser: the files you import, and
          the scripts you save back from your library. Any example opens as a
          script to rework, perform or export.
        </p>
      </header>

      {!state.bundledEnabled && activeFolderExamples.length === 0 && (
        <p className="example-warning" role="status">
          {userExamples.length === 0
            ? 'Nothing of your own here yet, so generation has nothing to ground itself in. Add material below, or search the bundled placeholder set instead.'
            : `"${state.activeFolder}" is grounding generation and it is empty. Ground generation in a folder that has files in it, or search the bundled placeholder set alongside it.`}
        </p>
      )}

      <div className="example-browser">
        <ExampleFolderRail
          folders={railFolders}
          bundled={
            bundledExamples.length > 0
              ? { count: bundledExamples.length, enabled: state.bundledEnabled }
              : null
          }
          viewing={state.view.kind === 'bundled' ? null : viewedFolder}
          onFolderViewed={folder => dispatch({ type: 'FOLDER_VIEWED', folder })}
          onBundledViewed={() => dispatch({ type: 'BUNDLED_VIEWED' })}
          onFolderCreated={handleFolderCreated}
        />

        {state.view.kind === 'bundled' ? (
          <BundledFolderView
            examples={bundledExamples}
            headingId="bundled-examples-heading"
            enabled={state.bundledEnabled}
            selectionCounts={selectionCounts}
            onEnabledChanged={handleBundledToggle}
          />
        ) : viewedFolder ? (
          <ExampleFolderView
            key={viewedFolder}
            folder={viewedFolder}
            headingId="example-folder-heading"
            examples={userExamples.filter(
              example => exampleFolder(example) === viewedFolder
            )}
            folders={folderOptions}
            active={viewedFolder === state.activeFolder}
            selectionCounts={selectionCounts}
            rewritingExampleId={state.rewrite.runningId}
            cleanupFiles={
              state.cleanup.folder === viewedFolder ? state.cleanup.files : []
            }
            cleanupNote={
              state.cleanup.folder === viewedFolder ? state.cleanup.note : null
            }
            cleanupRunning={state.cleanup.running}
            onActivated={handleFolderActivated}
            onFolderRenamed={handleFolderRenamed}
            onFolderDeleted={handleFolderDelete}
            onExampleDeleted={handleDelete}
            onDetailsSaved={handleDetailsSaved}
            onOpenAsScript={handleOpenAsScript}
            onRewriteExample={example => {
              void handleRewriteExample(example)
            }}
            onCleanUpFolder={(name, untidy) => {
              void handleCleanUp(name, untidy)
            }}
            onCleanUpExample={(name, example) => {
              void handleCleanUp(name, [example])
            }}
          />
        ) : (
          <p className="example-nothing-yet">
            No folders of your own yet. Add a markdown or text file below and
            the folder it lands in appears here.
          </p>
        )}
      </div>

      {state.rewrite.note && (
        <p className="example-rewrite-result" role="status" aria-live="polite">
          {state.rewrite.note}
        </p>
      )}

      <details className="example-drawer">
        <summary>Add material</summary>

        <form className="example-import" aria-label="Import example scripts">
        <label htmlFor="example-import-destination">Import into</label>
        <select
          id="example-import-destination"
          value={state.importDestination}
          onChange={event =>
            dispatch({
              type: 'IMPORT_DESTINATION_CHANGED',
              folder: event.target.value
            })
          }
          aria-describedby="example-import-destination-help"
        >
          <option value="">The folder each file came from</option>
          {folderOptions.map(folder => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
        <p id="example-import-destination-help">
          {state.importDestination
            ? `Everything imported below goes into "${state.importDestination}", whatever it was filed under before.`
            : `A folder import files each script under the folder it sits in; files chosen individually join "${state.activeFolder}", the folder generation is using. Pick a folder above to send the whole import there instead.`}
        </p>

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
          imported; anything else is ignored.
        </p>

        <label className="checkbox-field" htmlFor="import-voicing">
          <input
            type="checkbox"
            id="import-voicing"
            checked={state.importVoicing}
            onChange={event => handleVoicingToggle(event.target.checked)}
            aria-describedby="import-voicing-help"
          />
          <span>Rewrite into direct address</span>
        </label>
        <p id="import-voicing-help">
          Material written about someone else, or spoken to a title, teaches
          generation a voice you are not writing in. With this on, the utility
          model puts each import into the second person and drops the titles
          of address — "drop for Mistress" becomes "drop for me". A rewrite
          that lost or padded the script is discarded. Off unless you ask: it
          is the one pass that changes what the script says.
        </p>

        <label htmlFor="example-import-transcript">
          Or import session transcripts
        </label>
        <input
          key={`transcript-${state.importCount}`}
          id="example-import-transcript"
          type="file"
          accept=".md,.markdown,.txt,.text,text/markdown,text/plain"
          multiple
          onChange={handleTranscriptImport}
          aria-describedby="example-import-transcript-help"
        />
        <p id="example-import-transcript-help">
          A recording of a session you ran. The utility model splits it into
          the same section files a generated script has, and drops speaker
          labels, timestamps and the client&rsquo;s replies. The words are
          kept as transcribed.
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

        {state.split.status !== 'idle' && (
          <p className="example-split-result" role="status" aria-live="polite">
            {state.split.status === 'unavailable'
              ? 'Splitting a transcript needs a configured provider. The transcripts were imported as they are.'
              : describeTranscriptImport(state.split.outcome, state.split.model) ||
                'The utility model could not find sections in these transcripts.'}
          </p>
        )}

        {state.assist.status === 'finished' && (
          <p className="example-assist-result" role="status" aria-live="polite">
            {describeImportAssist(state.assist.outcome, state.assist.model) ||
              'The utility model found nothing to add to these imports.'}
          </p>
        )}
        </form>

        <LibraryPromotionForm
          key={`promote-${state.examples.length}-${state.activeFolder}`}
          scripts={promotableScripts}
          folders={folderOptions}
          defaultFolder={state.activeFolder}
          onPromote={handlePromoteScript}
        />

        {state.promotion.status === 'saved' && (
          <p className="example-promotion-result" role="status" aria-live="polite">
            {state.promotion.replaced
              ? `Updated the example held for "${state.promotion.title}" in "${state.promotion.folder}".`
              : `Saved "${state.promotion.title}" into "${state.promotion.folder}".`}
          </p>
        )}
      </details>
    </section>
  )
}
