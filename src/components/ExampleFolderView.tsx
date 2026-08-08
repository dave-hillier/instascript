import { useReducer, useState } from 'react'
import {
  Check,
  ChevronRight,
  FileText,
  Pencil,
  Sparkles,
  Tags,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import type { ExampleRecord } from '../types/example'
import { exampleFolder, parseTags, UNFILED_FOLDER } from '../services/exampleCorpus'
import { needsDirectAddress } from '../services/importAssist'
import { cleanupJobsFor } from '../services/exampleCleanup'
import {
  CLEANUP_PROGRESS_LABELS,
  type ImportFileProgress
} from '../services/importProgress'
import { ImportProgressMeter } from './ImportProgressMeter'
import {
  canonicalizeTags,
  customTagsIn,
  facetForTag,
  standardTagsIn
} from '../services/standardTags'
import { StandardTagFields } from './StandardTagFields'
import { countWords } from '../utils/scriptMetrics'
import { buildExampleFs } from '../services/exampleFs'
import { describeSelectionCount } from '../utils/exampleDisplay'

interface UserExampleDetailsFormProps {
  example: ExampleRecord
  folders: string[]
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
}

interface DetailsState {
  // The standard vocabulary's tags, held apart from the free ones so the
  // controls and the text field never fight over the same tag
  standard: string[]
  topicText: string
  folder: string
}

type DetailsEvent =
  | { type: 'FACET_CHOSEN'; facetId: string; tag: string }
  | { type: 'FEATURE_TOGGLED'; tag: string }
  | { type: 'TOPIC_TAGS_EDITED'; text: string }
  | { type: 'FOLDER_CHOSEN'; folder: string }

function detailsReducer(state: DetailsState, event: DetailsEvent): DetailsState {
  switch (event.type) {
    case 'FACET_CHOSEN': {
      // A facet holds one value at a time, so choosing replaces rather than
      // adds, and choosing the empty option leaves the facet unsaid
      const others = state.standard.filter(tag => facetForTag(tag)?.id !== event.facetId)
      return { ...state, standard: event.tag ? [...others, event.tag] : others }
    }
    case 'FEATURE_TOGGLED':
      return {
        ...state,
        standard: state.standard.includes(event.tag)
          ? state.standard.filter(tag => tag !== event.tag)
          : [...state.standard, event.tag]
      }
    case 'TOPIC_TAGS_EDITED':
      return { ...state, topicText: event.text }
    case 'FOLDER_CHOSEN':
      return { ...state, folder: event.folder }
  }
}

function initialDetails(example: ExampleRecord): DetailsState {
  return {
    standard: standardTagsIn(example.tags),
    topicText: customTagsIn(example.tags).join(', '),
    folder: exampleFolder(example)
  }
}

// Tags and folder for one example, saved together: all of them are how the
// example is filed, and one Save keeps the row from sprouting three buttons.
// Tags come in two kinds — the standard vocabulary (story 8.17) as controls,
// so the properties every script has an answer to are picked rather than
// spelled, and free topic tags as text. The folder is chosen from the folders
// that exist rather than typed, so a mistyped name cannot quietly strand an
// example in a folder of its own.
const UserExampleDetailsForm = ({
  example,
  folders,
  onDetailsSaved
}: UserExampleDetailsFormProps) => {
  const [details, dispatch] = useReducer(detailsReducer, example, initialDetails)

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onDetailsSaved(example.id, {
      // Standard tags lead; a standard tag typed into the topic field is
      // recognised as one rather than kept as a second spelling
      tags: canonicalizeTags([...details.standard, ...parseTags(details.topicText)]),
      folder: details.folder
    })
  }

  return (
    <form
      className="example-details-form"
      aria-label={`Edit tags and folder for ${example.title}`}
      onSubmit={handleSubmit}
    >
      <StandardTagFields
        idPrefix={example.id}
        tags={details.standard}
        onFacetChosen={(facetId, tag) => dispatch({ type: 'FACET_CHOSEN', facetId, tag })}
        onFeatureToggled={tag => dispatch({ type: 'FEATURE_TOGGLED', tag })}
      />
      <label className="sr-only" htmlFor={`${example.id}_tags`}>
        Topic tags for {example.title}, comma separated
      </label>
      <input
        id={`${example.id}_tags`}
        type="text"
        value={details.topicText}
        onChange={event => dispatch({ type: 'TOPIC_TAGS_EDITED', text: event.target.value })}
        placeholder="topic tags, comma separated"
      />
      <label className="sr-only" htmlFor={`${example.id}_folder`}>
        Folder for {example.title}
      </label>
      <select
        id={`${example.id}_folder`}
        value={details.folder}
        onChange={event => dispatch({ type: 'FOLDER_CHOSEN', folder: event.target.value })}
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

// The folder's name in the path line, and renaming it in place: the pencil
// swaps the name for an input, Enter or the check saves, Escape or the cross
// discards — the same gesture as renaming a script.
const FolderName = ({ folder, headingId, onRenamed }: FolderNameProps) => {
  // null when displaying; the in-progress text while renaming
  const [draft, setDraft] = useState<string | null>(null)

  if (draft === null) {
    return (
      <h3 className="example-path" id={headingId}>
        <span className="example-path-root">corpus</span>
        <span className="example-path-slash" aria-hidden="true">
          /
        </span>
        {folder}
        {folder !== UNFILED_FOLDER && (
          <button
            type="button"
            onClick={() => setDraft(folder)}
            aria-label={`Rename folder ${folder}`}
          >
            <Pencil size={13} />
          </button>
        )}
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

// The section files an example was divided into — by a transcript import
// (story 8.18) or by the clean-up pass (story 8.19) — addressed and listed
// the way the script filesystem addresses them. An example that has never
// been divided carries no specs, and renders without this.
const ExampleSectionTree = ({ example }: { example: ExampleRecord }) => {
  const tree = buildExampleFs(example)

  return (
    <ol className="example-tree">
      {tree.sections.map(section => (
        <li key={section.path}>
          <p className="example-tree-file">
            <code>{section.path}</code>
            <span className="example-tree-size">
              {section.wordCount.toLocaleString('en-US')} w
            </span>
          </p>
          <p className="example-tree-title">{section.title}</p>
          {section.prompt && <p className="example-tree-prompt">{section.prompt}</p>}
        </li>
      ))}
    </ol>
  )
}

interface ExampleRowProps {
  example: ExampleRecord
  folder: string
  folders: string[]
  selections: number
  rewriting: boolean
  cleanupRunning: boolean
  onExampleDeleted: (example: ExampleRecord) => void
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
  onOpenAsScript: (example: ExampleRecord) => void
  onRewriteExample: (example: ExampleRecord) => void
  onCleanUpExample: (folder: string, example: ExampleRecord) => void
}

// One example, listed as a file: its name, what it weighs, and the passes it
// is due. Everything that edits it — the tags, the folder it is filed in, the
// sections it was divided into — is behind the row's own disclosure, so a
// folder of forty reads as a listing rather than forty open forms.
const ExampleRow = ({
  example,
  folder,
  folders,
  selections,
  rewriting,
  cleanupRunning,
  onExampleDeleted,
  onDetailsSaved,
  onOpenAsScript,
  onRewriteExample,
  onCleanUpExample
}: ExampleRowProps) => {
  const [open, setOpen] = useState(false)
  const detailsId = `${example.id}_details`
  const sections = example.sections?.length ?? 0

  return (
    <li className="example-file" data-open={open}>
      <div className="example-file-row">
        <h4>
          <button
            type="button"
            className="example-file-name"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={14} aria-hidden="true" />
            {example.title}
          </button>
        </h4>
        <p className="example-file-meta">
          {sections > 0
            ? `${sections} ${sections === 1 ? 'section' : 'sections'}`
            : 'one file'}
          {' · '}
          {describeSelectionCount(selections)}
          {example.sourceScriptId && ' · from your library'}
          {example.tags.length > 0 && ` · ${example.tags.join(', ')}`}
        </p>
        <p className="example-file-size">
          {countWords(example.content).toLocaleString('en-US')} w
        </p>
        <div className="example-actions">
          {/* The two passes are offered only where they have something to
              do: an example already titled, sectioned and tagged, or one
              that already speaks to the listener, has nothing to gain */}
          {cleanupJobsFor(example).length > 0 && (
            <button
              type="button"
              onClick={() => onCleanUpExample(folder, example)}
              disabled={cleanupRunning}
              aria-label={`Clean up ${example.title}`}
              title="Clean up"
            >
              <Sparkles size={15} />
            </button>
          )}
          {needsDirectAddress(example.content) && (
            <button
              type="button"
              onClick={() => onRewriteExample(example)}
              disabled={rewriting}
              aria-label={`Rewrite ${example.title} into direct address`}
              title="Rewrite into direct address"
            >
              <Wand2 size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`Edit tags and folder for ${example.title}`}
            title="Tags and folder"
          >
            <Tags size={15} />
          </button>
          <button
            type="button"
            onClick={() => onOpenAsScript(example)}
            aria-label={`Open ${example.title} as a script`}
            title="Open as script"
          >
            <FileText size={15} />
          </button>
          <button
            type="button"
            className="example-delete"
            onClick={() => onExampleDeleted(example)}
            aria-label={`Delete example ${example.title}`}
            title="Delete"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {open && (
        <div className="example-file-details" id={detailsId}>
          {sections > 0 && <ExampleSectionTree example={example} />}
          <UserExampleDetailsForm
            key={`${example.id}_${example.tags.join(',')}_${exampleFolder(example)}`}
            example={example}
            folders={folders}
            onDetailsSaved={onDetailsSaved}
          />
        </div>
      )}
    </li>
  )
}

interface ExampleFolderViewProps {
  folder: string
  headingId: string
  examples: ExampleRecord[]
  folders: string[]
  active: boolean
  selectionCounts: Record<string, number>
  // The example being rewritten into direct address right now, if any
  rewritingExampleId: string | null
  // The rows of a clean-up run over this folder, empty when the last run was
  // somewhere else, and the line it finished on
  cleanupFiles: ImportFileProgress[]
  cleanupNote: string | null
  // Whether a clean-up is running anywhere on the page: they go one at a
  // time, so the buttons close everywhere while one is out
  cleanupRunning: boolean
  onActivated: (folder: string) => void
  onFolderRenamed: (from: string, to: string) => void
  onFolderDeleted: (folder: string) => void
  onExampleDeleted: (example: ExampleRecord) => void
  onDetailsSaved: (id: string, details: { tags: string[]; folder: string }) => void
  onOpenAsScript: (example: ExampleRecord) => void
  onRewriteExample: (example: ExampleRecord) => void
  onCleanUpFolder: (folder: string, examples: ExampleRecord[]) => void
  onCleanUpExample: (folder: string, example: ExampleRecord) => void
}

// The folder being browsed, opened out: its path, what it holds, and what can
// be done to it. Which folder grounds generation is one choice across the
// whole corpus, so it is made here, on the folder in front of you, rather
// than repeated beside every folder in the rail.
export const ExampleFolderView = ({
  folder,
  headingId,
  examples,
  folders,
  active,
  selectionCounts,
  rewritingExampleId,
  cleanupFiles,
  cleanupNote,
  cleanupRunning,
  onActivated,
  onFolderRenamed,
  onFolderDeleted,
  onExampleDeleted,
  onDetailsSaved,
  onOpenAsScript,
  onRewriteExample,
  onCleanUpFolder,
  onCleanUpExample
}: ExampleFolderViewProps) => {
  const words = examples.reduce((total, example) => total + countWords(example.content), 0)
  // The examples here with something for the clean-up pass to do. Offered
  // only where there is work: a folder of properly titled, sectioned and
  // tagged scripts has nothing to gain from a round of requests.
  const untidy = examples.filter(example => cleanupJobsFor(example).length > 0)

  return (
    <section className="example-view" aria-labelledby={headingId} data-active={active}>
      <header>
        <FolderName folder={folder} headingId={headingId} onRenamed={onFolderRenamed} />
        <p className="example-view-meta">
          {examples.length === 0
            ? 'empty'
            : `${examples.length} ${examples.length === 1 ? 'file' : 'files'} · ${words.toLocaleString('en-US')} words`}
        </p>
        <div className="example-view-actions">
          <button
            type="button"
            className="example-grounding"
            aria-pressed={active}
            onClick={() => onActivated(folder)}
          >
            {active ? 'Grounding generation' : 'Ground generation here'}
          </button>
          {untidy.length > 0 && (
            <button
              type="button"
              disabled={cleanupRunning}
              onClick={() => onCleanUpFolder(folder, untidy)}
              aria-describedby={`${headingId}_cleanup_help`}
            >
              <Sparkles size={14} />
              {untidy.length === 1 ? 'Clean up 1 file' : `Clean up ${untidy.length} files`}
            </button>
          )}
          <button
            type="button"
            className="example-folder-delete"
            onClick={() => onFolderDeleted(folder)}
          >
            <Trash2 size={14} />
            Delete folder
          </button>
        </div>
      </header>

      {untidy.length > 0 && (
        <p className="example-folder-cleanup-help" id={`${headingId}_cleanup_help`}>
          The utility model names the scripts still titled after the file they
          arrived in, divides the ones with no sections into sections with a
          spec each, and tags the ones tagged before the standard vocabulary
          existed. It leaves the words of every script alone.
        </p>
      )}

      <ImportProgressMeter files={cleanupFiles} labels={CLEANUP_PROGRESS_LABELS} />

      {cleanupNote && (
        <p className="example-cleanup-result" role="status" aria-live="polite">
          {cleanupNote}
        </p>
      )}

      {examples.length === 0 ? (
        <p className="example-folder-empty">
          Nothing filed here yet. Import into this folder, or move an example
          into it from another.
        </p>
      ) : (
        <ul className="example-files">
          {examples.map(example => (
            <ExampleRow
              key={example.id}
              example={example}
              folder={folder}
              folders={folders}
              selections={selectionCounts[example.id] ?? 0}
              rewriting={rewritingExampleId !== null}
              cleanupRunning={cleanupRunning}
              onExampleDeleted={onExampleDeleted}
              onDetailsSaved={onDetailsSaved}
              onOpenAsScript={onOpenAsScript}
              onRewriteExample={onRewriteExample}
              onCleanUpExample={onCleanUpExample}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

interface BundledFolderViewProps {
  examples: ExampleRecord[]
  headingId: string
  enabled: boolean
  selectionCounts: Record<string, number>
  onEnabledChanged: (enabled: boolean) => void
}

// The bundled placeholder set, browsed the same way and written to by nobody.
// Whether it is searched alongside the folder in use is a property of this
// set, so the switch lives on it rather than in a settings panel elsewhere.
export const BundledFolderView = ({
  examples,
  headingId,
  enabled,
  selectionCounts,
  onEnabledChanged
}: BundledFolderViewProps) => {
  const words = examples.reduce((total, example) => total + countWords(example.content), 0)

  return (
    <section className="example-view" aria-labelledby={headingId} data-active={enabled}>
      <header>
        <h3 className="example-path" id={headingId}>
          <span className="example-path-root">corpus</span>
          <span className="example-path-slash" aria-hidden="true">
            /
          </span>
          Bundled
        </h3>
        <p className="example-view-meta">
          {examples.length} files · {words.toLocaleString('en-US')} words · read-only
        </p>
        <div className="example-view-actions">
          <label className="checkbox-field" htmlFor="bundled-examples">
            <input
              type="checkbox"
              id="bundled-examples"
              checked={enabled}
              onChange={event => onEnabledChanged(event.target.checked)}
              aria-describedby="bundled-examples-help"
            />
            <span>Search alongside the folder in use</span>
          </label>
        </div>
      </header>

      <p className="example-folder-cleanup-help" id="bundled-examples-help">
        Short placeholder scripts that ship with the app. They are stubs, so
        leaving them out keeps generation grounded only in material whose
        style you chose.
      </p>

      <ul className="example-files" data-excluded={!enabled}>
        {examples.map(example => (
          <li key={example.id} className="example-file">
            <div className="example-file-row">
              <h4>
                <span className="example-file-name">{example.title}</span>
              </h4>
              <p className="example-file-meta">
                {describeSelectionCount(selectionCounts[example.id] ?? 0)}
                {example.tags.length > 0 && ` · ${example.tags.join(', ')}`}
              </p>
              <p className="example-file-size">
                {countWords(example.content).toLocaleString('en-US')} w
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
