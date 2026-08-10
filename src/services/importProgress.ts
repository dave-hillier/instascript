// The per-file state of an example import. A folder import can be dozens of
// files, each of which is read, saved, and then possibly handed to the utility
// model (story 5.7) — several seconds of silence per file. This module is the
// pure half of the progress meter: the stages a file moves through, how far
// through the work each stage is, and how a finished import reads back.

export type ImportStage =
  // Selected, not started
  | 'queued'
  // Being read off disk
  | 'reading'
  // Parsed and stored as an example; the tidy pass may still touch it
  | 'saved'
  // The utility model is putting the script into direct address
  | 'voicing'
  // The utility model is splitting a transcript into section files
  | 'splitting'
  // The utility model is naming a script still titled after its file
  | 'retitling'
  // The utility model is dividing a script already in the corpus into
  // sections, the same shape a transcript is split into
  | 'sectioning'
  // The utility model is laying the script out as markdown
  | 'formatting'
  // The utility model is suggesting tags
  | 'tagging'
  // The utility model is reading an example for the devices it uses
  | 'devices'
  // Terminal
  | 'done'
  | 'skipped'
  | 'failed'

export interface ImportFileProgress {
  // Stable for the life of one import: a folder and a multi-file selection can
  // both contribute the same file name, and rows must not swap identity
  id: string
  path: string
  name: string
  stage: ImportStage
  // Why a file was skipped or failed, when the stage alone does not say
  note?: string
  // The example this file became, once saved
  exampleId?: string
}

// How far through its journey a file at this stage is, as a fraction. The
// utility model jobs are the slow part, so they get the wider bands.
const STAGE_FRACTION: Record<ImportStage, number> = {
  queued: 0,
  reading: 0.3,
  saved: 0.5,
  // Voicing and splitting are the same slot in two alternative pipelines —
  // a plain file is put into direct address, a transcript is split — so they
  // fill the bar to the same point rather than one following the other
  voicing: 0.65,
  splitting: 0.65,
  // The clean-up pass (story 8.19) runs its own three stages over an example
  // already in the corpus, so it starts where an import has already got to
  retitling: 0.35,
  sectioning: 0.65,
  formatting: 0.8,
  tagging: 0.9,
  // The device pass (story 8.20) is one request per example, so a row is
  // either waiting on it or done
  devices: 0.5,
  done: 1,
  skipped: 1,
  failed: 1
}

const STAGE_LABEL: Record<ImportStage, string> = {
  queued: 'Queued',
  reading: 'Reading file',
  saved: 'Saved to corpus',
  voicing: 'Rewriting into direct address',
  splitting: 'Splitting into sections',
  retitling: 'Choosing a title',
  sectioning: 'Dividing into sections',
  formatting: 'Formatting as markdown',
  tagging: 'Suggesting tags',
  devices: 'Reading for devices',
  done: 'Imported',
  skipped: 'Skipped',
  failed: 'Failed'
}

const TERMINAL_STAGES: ImportStage[] = ['done', 'skipped', 'failed']

export function isImportStageTerminal(stage: ImportStage): boolean {
  return TERMINAL_STAGES.includes(stage)
}

// Pure: how full this file's bar is drawn, 0 to 1
export function importStageFraction(stage: ImportStage): number {
  return STAGE_FRACTION[stage]
}

// Pure: what this file is doing right now, for the meter row. Only the
// terminal label varies: an import ends with a file imported, while the
// clean-up pass (story 8.19) ends with an example already in the corpus
// tidied, and nothing was imported at all.
export function describeImportStage(stage: ImportStage, doneLabel = STAGE_LABEL.done): string {
  return stage === 'done' ? doneLabel : STAGE_LABEL[stage]
}

// Pure: the queue a file selection starts as. Paths arrive from the file
// input, already flattened when a whole folder was chosen, and already
// filtered down to the files that can become examples — a folder brings its
// images, PDFs and dotfiles along, and the meter counts the import rather
// than the folder.
export function createImportProgress(paths: string[]): ImportFileProgress[] {
  return paths.map((path, index) => ({
    id: `${index}:${path}`,
    path,
    name: path.split('/').pop() || path,
    stage: 'queued'
  }))
}

// Pure: one file moved on. Anything else in the list is returned untouched, so
// a re-render only redraws the row that changed.
export function advanceImportFile(
  files: ImportFileProgress[],
  id: string,
  stage: ImportStage,
  patch: Pick<ImportFileProgress, 'note' | 'exampleId'> = {}
): ImportFileProgress[] {
  return files.map(file =>
    file.id === id
      ? {
          ...file,
          stage,
          note: patch.note ?? file.note,
          exampleId: patch.exampleId ?? file.exampleId
        }
      : file
  )
}

export interface ImportProgressSummary {
  // The files being imported — the queued rows, not everything the folder
  // happened to contain
  total: number
  settled: number
  imported: number
  skipped: number
  failed: number
  // Files the selection contained that were never candidates, so they are
  // reported afterwards rather than counted against the meter
  ignored: number
  finished: boolean
}

// Pure: the headline counts, derived from the rows rather than tracked
// alongside them, so the two can never disagree. The ignored count is the
// one thing the rows cannot say, since those files never got a row.
export function summarizeImportProgress(
  files: ImportFileProgress[],
  ignored = 0
): ImportProgressSummary {
  const summary: ImportProgressSummary = {
    total: files.length,
    settled: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    ignored,
    finished: false
  }

  for (const file of files) {
    if (!isImportStageTerminal(file.stage)) continue
    summary.settled += 1
    if (file.stage === 'done') summary.imported += 1
    if (file.stage === 'skipped') summary.skipped += 1
    if (file.stage === 'failed') summary.failed += 1
  }

  // A selection of nothing but unsupported files still finishes — it has an
  // outcome to report, it just has no rows to report it through
  summary.finished =
    (files.length > 0 || ignored > 0) && summary.settled === files.length
  return summary
}

// What the rows are counted in: files for an import, examples for the
// clean-up pass that reuses the meter
export interface ProgressNoun {
  one: string
  many: string
}

// What the meter says it is a meter of. The rows and the stages are the same
// either way — a file being imported and an example being cleaned up both sit
// on the same utility-model requests — so only the wording changes.
export interface ProgressMeterLabels {
  region: string
  busy: string
  finished: string
  // The terminal row label: what a row that got all the way through is
  done: string
  track: string
  noun: ProgressNoun
}

export const IMPORT_PROGRESS_LABELS: ProgressMeterLabels = {
  region: 'Import progress',
  busy: 'Importing',
  finished: 'Import complete',
  done: 'Imported',
  track: 'Files processed',
  noun: { one: 'file', many: 'files' }
}

export const CLEANUP_PROGRESS_LABELS: ProgressMeterLabels = {
  region: 'Clean-up progress',
  busy: 'Cleaning up',
  finished: 'Clean-up complete',
  done: 'Cleaned up',
  track: 'Examples processed',
  noun: { one: 'example', many: 'examples' }
}

export const DEVICE_PROGRESS_LABELS: ProgressMeterLabels = {
  region: 'Device extraction progress',
  busy: 'Reading the corpus',
  finished: 'Corpus read',
  done: 'Read',
  track: 'Examples read',
  noun: { one: 'example', many: 'examples' }
}

// Pure: the progress line above the rows, while the rows are still moving
export function describeImportProgress(
  summary: ImportProgressSummary,
  noun: ProgressNoun = IMPORT_PROGRESS_LABELS.noun
): string {
  return `${summary.settled} of ${summary.total} ${summary.total === 1 ? noun.one : noun.many}`
}

// Pure: how a finished import reads back. Folder imports routinely pass files
// over, so say so plainly rather than reporting only what landed — the files
// that never entered the queue are accounted for here instead of in the meter.
export function describeImportOutcome({
  total,
  imported,
  skipped,
  failed,
  ignored
}: ImportProgressSummary): string {
  const ignoredFiles = `${ignored} ${
    ignored === 1 ? 'file that is not' : 'files that are not'
  } markdown or text`

  if (total === 0) return `Nothing to import: ignored ${ignoredFiles}.`

  const parts = [`Imported ${imported} ${imported === 1 ? 'example' : 'examples'}`]
  if (skipped > 0) parts.push(`skipped ${skipped} empty ${skipped === 1 ? 'file' : 'files'}`)
  if (failed > 0) parts.push(`${failed} could not be read`)
  if (ignored > 0) parts.push(`ignored ${ignoredFiles}`)
  return `${parts.join(', ')}.`
}
