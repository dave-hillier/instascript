import { HardDriveDownload, X } from 'lucide-react'

type BackupReminderProps = {
  newScriptCount: number
  lastExportedAt: number | null
  onExport: () => void
  onDismiss: () => void
}

const scriptPhrase = (count: number): string =>
  count === 1 ? '1 script' : `${count} scripts`

// Non-blocking nudge (story 7.4): the library only exists in this browser
// profile, so when new work accrues without an export the app suggests one.
// Dismissible, and can be turned off entirely in Settings.
export const BackupReminder = ({
  newScriptCount,
  lastExportedAt,
  onExport,
  onDismiss
}: BackupReminderProps) => (
  <aside className="backup-reminder" role="status" aria-live="polite">
    <p>
      {lastExportedAt === null
        ? `Your library has never been exported — ${scriptPhrase(newScriptCount)} exist only in this browser.`
        : `${scriptPhrase(newScriptCount)} created since your last export on ${new Date(lastExportedAt).toLocaleDateString()} exist only in this browser.`}
    </p>
    <button type="button" onClick={onExport}>
      <HardDriveDownload size={16} />
      <span>Export now</span>
    </button>
    <button type="button" onClick={onDismiss} aria-label="Dismiss backup reminder">
      <X size={16} />
    </button>
  </aside>
)
