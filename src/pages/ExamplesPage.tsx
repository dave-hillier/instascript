import { useEffect, useReducer, useState } from 'react'
import { Trash2, Check } from 'lucide-react'
import type { ExampleRecord, ExampleGroupSummary } from '../types/example'
import {
  applyExampleEnhancement,
  backfillMissingEmbeddings,
  getAllExamples,
  getDisabledGroups,
  getExampleSelectionCounts,
  getKnownTags,
  importExampleFile,
  isImportableExampleFile,
  deleteUserExample,
  renameExampleGroup,
  setGroupEnabled,
  summarizeGroups,
  updateUserExampleGroup,
  updateUserExampleTags,
  normalizeGroupName,
  parseTags,
  UNGROUPED
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
  // Groups switched off are excluded from retrieval. Stored as the disabled
  // list so a freshly imported group is on without being registered first.
  disabledGroups: string[]
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
  | { type: 'EXAMPLE_GROUP_CHANGED'; id: string; group: string }
  | { type: 'GROUP_TOGGLED'; group: string; enabled: boolean }
  | { type: 'GROUP_RENAMED'; from: string; to: string }
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
    case 'GROUP_TOGGLED':
      return {
        ...state,
        disabledGroups: action.enabled
          ? state.disabledGroups.filter(group => group !== action.group)
          : [...new Set([...state.disabledGroups, action.group])]
      }
    case 'GROUP_RENAMED':
      return {
        ...state,
        examples: state.examples.map(example =>
          example.group === action.from ? { ...example, group: action.to } : example
        ),
        // A disabled group stays disabled under its new name. Renaming onto an
        // existing group merges the two, so the list is deduplicated.
        disabledGroups: [
          ...new Set(
            state.disabledGroups.map(group => (group === action.from ? action.to : group))
          )
        ]
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
    case 'EXAMPLE_GROUP_CHANGED':
      return {
        ...state,
        examples: state.examples.map(example =>
          example.id === action.id ? { ...example, group: action.group } : example
        )
      }
    default:
      return state
  }
}

// How often the example has actually informed a generation (story 8.11)
const describeSelectionCount = (count: number): string => {
  if (count === 0) return 'Never selected for a generation'
  return `Selected for ${count} ${count === 1 ? 'generation' : 'generations'}`
}

const describeGroupSize = (count: number): string =>
  `${count} ${count === 1 ? 'example' : 'examples'}`

interface UserExampleDetailsFormProps {
  example: ExampleRecord
  onDetailsSaved: (id: string, group: string, tags: string[]) => void
}

// Group and tags for one example. The group is free text: typing a name no
// other example uses creates that group, and emptying it returns the example
// to the ungrouped bucket.
const UserExampleDetailsForm = ({ example, onDetailsSaved }: UserExampleDetailsFormProps) => {
  const [groupText, setGroupText] = useState(example.group)
  const [tagText, setTagText] = useState(example.tags.join(', '))

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onDetailsSaved(example.id, normalizeGroupName(groupText), parseTags(tagText))
  }

  return (
    <form
      className="example-details-form"
      aria-label={`Edit group and tags for ${example.title}`}
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor={`${example.id}_group`}>
        Group for {example.title}
      </label>
      <input
        id={`${example.id}_group`}
        type="text"
        list="example-group-names"
        value={groupText}
        onChange={event => setGroupText(event.target.value)}
        placeholder="group"
      />
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
      <button type="submit" aria-label={`Save group and tags for ${example.title}`}>
        <Check size={14} />
        Save
      </button>
    </form>
  )
}

interface GroupRenameFormProps {
  group: ExampleGroupSummary
  onRenamed: (from: string, to: string) => void
}

const GroupRenameForm = ({ group, onRenamed }: GroupRenameFormProps) => {
  const [name, setName] = useState(group.name)

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onRenamed(group.name, normalizeGroupName(name))
  }

  return (
    <form
      className="group-rename-form"
      aria-label={`Rename the group ${group.name}`}
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor={`group-name-${group.name}`}>
        Name of the group {group.name}
      </label>
      <input
        id={`group-name-${group.name}`}
        type="text"
        value={name}
        onChange={event => setName(event.target.value)}
      />
      <button type="submit" aria-label={`Save the name of the group ${group.name}`}>
        <Check size={14} />
        Rename
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
      disabledGroups: getDisabledGroups(),
      importFiles: [],
      assist: { status: 'idle' }
    })
  )
  // The group single files land in. A folder import takes its group from the
  // folder instead, so this only applies to the file picker.
  const [importGroup, setImportGroup] = useState('')
  const importSummary = summarizeImportProgress(state.importFiles)
  const selectionCounts = getExampleSelectionCounts()
  const groups = summarizeGroups(state.examples, state.disabledGroups)
  const enabledExampleCount = groups
    .filter(group => group.enabled)
    .reduce((total, group) => total + group.count, 0)

  // Migration: examples saved before embeddings existed get theirs computed
  // once in the background; retrieval works without them in the meantime
  useEffect(() => {
    void backfillMissingEmbeddings()
  }, [])

  // Handles both single files and whole folders: a folder selection arrives
  // as its flattened contents, so anything that is not a markdown or text
  // file is skipped rather than imported as gibberish. Each file's group
  // comes from the folder holding it, so one import can create several.
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
        const example = importExampleFile(path, text, normalizeGroupName(importGroup))
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

  const handleGroupToggle = (group: string, enabled: boolean) => {
    setGroupEnabled(group, enabled)
    dispatch({ type: 'GROUP_TOGGLED', group, enabled })
  }

  const handleGroupRenamed = (from: string, to: string) => {
    if (from === to) return
    renameExampleGroup(from, to)
    dispatch({ type: 'GROUP_RENAMED', from, to })
  }

  const handleDelete = (example: ExampleRecord) => {
    if (confirm(`Delete the example "${example.title}"? This cannot be undone.`)) {
      deleteUserExample(example.id)
      dispatch({ type: 'EXAMPLE_DELETED', id: example.id })
    }
  }

  const handleDetailsSaved = (id: string, group: string, tags: string[]) => {
    updateUserExampleTags(id, tags)
    updateUserExampleGroup(id, group)
    dispatch({ type: 'EXAMPLE_TAGS_CHANGED', id, tags })
    dispatch({ type: 'EXAMPLE_GROUP_CHANGED', id, group })
  }

  return (
    <section className="examples-page">
      <header>
        <h2>Example corpus</h2>
        <p>
          Generation is grounded in these scripts. Your imports and promoted
          scripts are stored in this browser. Examples belong to groups —
          normally the folder they were imported from — and only the groups
          switched on below are searched, so the style a generation imitates is
          the style of the groups you leave on.
        </p>
      </header>

      {enabledExampleCount === 0 && (
        <p className="example-warning" role="status">
          No group is switched on, so generation has nothing to ground itself
          in. Import a folder of scripts below, promote a script you have
          written, or switch a group on.
        </p>
      )}

      <form className="example-settings" aria-label="Corpus settings">
        <fieldset>
          <legend>Groups searched during generation</legend>
          {groups.length === 0 ? (
            <p>No groups yet. Importing examples creates them.</p>
          ) : (
            <ul className="example-group-settings">
              {groups.map(group => (
                <li key={group.name}>
                  <label className="checkbox-field" htmlFor={`group-${group.name}`}>
                    <input
                      type="checkbox"
                      id={`group-${group.name}`}
                      checked={group.enabled}
                      onChange={event => handleGroupToggle(group.name, event.target.checked)}
                    />
                    <span>{group.name}</span>
                  </label>
                  <span className="example-group-size">{describeGroupSize(group.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <p>
          A group switched off stays listed and keeps its examples; it is only
          excluded from retrieval. The bundled placeholder scripts are a group
          like any other, off until you switch them on.
        </p>
      </form>

      <form className="example-import" aria-label="Import example scripts">
        <label htmlFor="example-import-group">Group for imported files</label>
        <input
          id="example-import-group"
          type="text"
          list="example-group-names"
          value={importGroup}
          onChange={event => setImportGroup(event.target.value)}
          placeholder={UNGROUPED}
          aria-describedby="example-import-group-help"
        />
        <p id="example-import-group-help">
          Used for files picked individually. A folder import ignores it and
          names each group after the folder the file sits in, so subfolders
          become their own groups.
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

      {/* Offers the existing group names as suggestions wherever one is typed,
          so moving an example into a group does not depend on retyping it
          exactly */}
      <datalist id="example-group-names">
        {groups.map(group => (
          <option key={group.name} value={group.name} />
        ))}
      </datalist>

      {state.examples.length === 0 ? (
        <p>No examples yet. Import a markdown or text file to get started.</p>
      ) : (
        groups.map(group => (
          <section
            key={group.name}
            className="example-group"
            aria-label={`Group ${group.name}`}
            data-excluded={!group.enabled}
          >
            <header>
              <h3>{group.name}</h3>
              <p className="example-group-meta">
                {describeGroupSize(group.count)}
                {' · '}
                {group.enabled ? 'Searched during generation' : 'Excluded from generation'}
              </p>
              {!group.readOnly && (
                <GroupRenameForm group={group} onRenamed={handleGroupRenamed} />
              )}
            </header>

            <ul className="example-list">
              {state.examples
                .filter(example => example.group === group.name)
                .map(example => (
                  <li key={example.id}>
                    <div className="example-summary">
                      <h4>{example.title}</h4>
                      <p className="example-meta">
                        {example.source === 'bundled' ? 'Bundled · read-only' : 'Yours'}
                        {' · '}
                        {countWords(example.content).toLocaleString('en-US')} words
                        {' · '}
                        {describeSelectionCount(selectionCounts[example.id] ?? 0)}
                        {example.source === 'bundled' && example.tags.length > 0 && (
                          <> · {example.tags.join(', ')}</>
                        )}
                      </p>
                      {example.source === 'user' && (
                        <UserExampleDetailsForm
                          key={`${example.id}_${example.group}_${example.tags.join(',')}`}
                          example={example}
                          onDetailsSaved={handleDetailsSaved}
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
          </section>
        ))
      )}
    </section>
  )
}
