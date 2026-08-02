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
  // The utility model is laying the script out as markdown
  | 'formatting'
  // The utility model is suggesting tags
  | 'tagging'
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
  saved: 0.55,
  formatting: 0.75,
  tagging: 0.9,
  done: 1,
  skipped: 1,
  failed: 1
}

const STAGE_LABEL: Record<ImportStage, string> = {
  queued: 'Queued',
  reading: 'Reading file',
  saved: 'Saved to corpus',
  formatting: 'Formatting as markdown',
  tagging: 'Suggesting tags',
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

// Pure: what this file is doing right now, for the meter row
export function describeImportStage(stage: ImportStage): string {
  return STAGE_LABEL[stage]
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

// Pure: the progress line above the rows, while files are still moving
export function describeImportProgress(summary: ImportProgressSummary): string {
  return `${summary.settled} of ${summary.total} ${summary.total === 1 ? 'file' : 'files'}`
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
