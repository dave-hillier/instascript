import {
  describeImportProgress,
  describeImportStage,
  importStageFraction,
  isImportStageTerminal,
  summarizeImportProgress,
  type ImportFileProgress
} from '../services/importProgress'

interface ImportProgressMeterProps {
  files: ImportFileProgress[]
}

// Every file in the current import, and what is happening to each. A folder
// import spends most of its time on the utility model passes, so the meter
// names the stage per file rather than showing one undifferentiated bar.
export const ImportProgressMeter = ({ files }: ImportProgressMeterProps) => {
  if (files.length === 0) return null

  const summary = summarizeImportProgress(files)

  return (
    <section className="import-meter" aria-label="Import progress">
      <header className="import-meter-header">
        <h3>{summary.finished ? 'Import complete' : 'Importing'}</h3>
        <p role="status" aria-live="polite">{describeImportProgress(summary)}</p>
      </header>

      <div
        className="import-meter-track"
        role="progressbar"
        aria-label="Files processed"
        aria-valuemin={0}
        aria-valuemax={summary.total}
        aria-valuenow={summary.settled}
        aria-valuetext={describeImportProgress(summary)}
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
              {describeImportStage(file.stage)}
              {file.note && <small>{file.note}</small>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
