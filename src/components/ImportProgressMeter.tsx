import {
  describeImportProgress,
  describeImportStage,
  importStageFraction,
  isImportStageTerminal,
  summarizeImportProgress,
  IMPORT_PROGRESS_LABELS,
  type ImportFileProgress,
  type ProgressMeterLabels
} from '../services/importProgress'

interface ImportProgressMeterProps {
  files: ImportFileProgress[]
  labels?: ProgressMeterLabels
}

// Every file in the current import, and what is happening to each. A folder
// import spends most of its time on the utility model passes, so the meter
// names the stage per file rather than showing one undifferentiated bar. The
// clean-up pass (story 8.19) draws the same meter over the examples it is
// working through, for the same reason.
export const ImportProgressMeter = ({
  files,
  labels = IMPORT_PROGRESS_LABELS
}: ImportProgressMeterProps) => {
  if (files.length === 0) return null

  const summary = summarizeImportProgress(files)
  const progress = describeImportProgress(summary, labels.noun)

  return (
    <section className="import-meter" aria-label={labels.region}>
      <header className="import-meter-header">
        <h3>{summary.finished ? labels.finished : labels.busy}</h3>
        <p role="status" aria-live="polite">{progress}</p>
      </header>

      <div
        className="import-meter-track"
        role="progressbar"
        aria-label={labels.track}
        aria-valuemin={0}
        aria-valuemax={summary.total}
        aria-valuenow={summary.settled}
        aria-valuetext={progress}
      >
        <div
          className="import-meter-fill"
          style={{ width: `${(summary.settled / summary.total) * 100}%` }}
        />
      </div>

      <ol className="import-meter-files">
        {files.map(file => (
          <li key={file.id} data-stage={file.stage}>
            <span className="import-meter-name" title={file.path}>
              {file.name}
            </span>
            <div className="import-meter-track">
              <div
                className="import-meter-fill"
                style={{ width: `${importStageFraction(file.stage) * 100}%` }}
              />
            </div>
            <span
              className="import-meter-stage"
              aria-busy={!isImportStageTerminal(file.stage)}
            >
              {describeImportStage(file.stage, labels.done)}
              {file.note && <small>{file.note}</small>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
