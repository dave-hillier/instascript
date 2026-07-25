// Backup staleness tracking (story 7.4): the library lives entirely in one
// browser profile, so the app tracks when it was last exported and how much
// new work has accrued since, and surfaces a non-blocking reminder when the
// export is stale. Everything here is strictly local — localStorage only.

export const EXPORT_SNAPSHOT_KEY = 'libraryExportSnapshot'
export const REMINDER_ENABLED_KEY = 'backupReminderEnabled'
export const REMINDER_DISMISSAL_KEY = 'backupReminderDismissal'
export const AUTO_BACKUP_LAST_WRITTEN_KEY = 'autoBackupLastWrittenAt'
export const AUTO_BACKUP_SIGNATURE_KEY = 'autoBackupSignature'

// How many new scripts justify a nudge on their own
export const NEW_SCRIPTS_BEFORE_REMINDER = 3
// After this long, even a single unexported script makes the export stale
export const STALE_EXPORT_AFTER_MS = 14 * 24 * 60 * 60 * 1000
// A dismissal is honoured for this long unless further work accrues
export const REMIND_AGAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000
// Minimum gap between automatic writes to a linked backup folder
export const AUTO_BACKUP_THROTTLE_MS = 5 * 60 * 1000

// What the library looked like at the moment of the last export
export interface ExportSnapshot {
  exportedAt: number
  scriptIds: string[]
}

// A dismissed reminder stays quiet until more work accrues or enough time passes
export interface ReminderDismissal {
  dismissedAt: number
  newScriptCount: number
}

export interface BackupReminderInput {
  enabled: boolean
  snapshot: ExportSnapshot | null
  currentScriptIds: string[]
  dismissal: ReminderDismissal | null
  now: number
}

export interface BackupReminderStatus {
  due: boolean
  newScriptCount: number
  lastExportedAt: number | null
}

// Scripts present now that were not part of the last export. A library that
// has never been exported counts everything as new.
export const countNewScripts = (
  snapshot: ExportSnapshot | null,
  currentScriptIds: string[]
): number => {
  if (!snapshot) return currentScriptIds.length
  const exported = new Set(snapshot.scriptIds)
  return currentScriptIds.filter(id => !exported.has(id)).length
}

export const evaluateBackupReminder = (input: BackupReminderInput): BackupReminderStatus => {
  const { enabled, snapshot, currentScriptIds, dismissal, now } = input
  const newScriptCount = countNewScripts(snapshot, currentScriptIds)
  const lastExportedAt = snapshot ? snapshot.exportedAt : null
  const status = { newScriptCount, lastExportedAt }

  if (!enabled || currentScriptIds.length === 0 || newScriptCount === 0) {
    return { ...status, due: false }
  }

  const enoughNewWork = newScriptCount >= NEW_SCRIPTS_BEFORE_REMINDER
  const exportIsOld = snapshot !== null && now - snapshot.exportedAt >= STALE_EXPORT_AFTER_MS
  if (!enoughNewWork && !exportIsOld) {
    return { ...status, due: false }
  }

  // A dismissal holds while no further scripts have accrued beyond what the
  // user saw when dismissing, and only for a limited time
  if (
    dismissal &&
    newScriptCount <= dismissal.newScriptCount &&
    now - dismissal.dismissedAt < REMIND_AGAIN_AFTER_MS
  ) {
    return { ...status, due: false }
  }

  return { ...status, due: true }
}

// Automatic backup writes are throttled: at most one write per interval
export const shouldWriteAutoBackup = (lastWrittenAt: number | null, now: number): boolean =>
  lastWrittenAt === null || now - lastWrittenAt >= AUTO_BACKUP_THROTTLE_MS

// How long to wait before the next automatic write is allowed (0 when due now)
export const autoBackupDelay = (lastWrittenAt: number | null, now: number): number =>
  lastWrittenAt === null ? 0 : Math.max(0, AUTO_BACKUP_THROTTLE_MS - (now - lastWrittenAt))

// A cheap fingerprint of the library, so the automatic backup only rewrites
// the file when something has actually changed since the last write
export const librarySignature = (
  scripts: Array<{ id: string; title: string; status?: string; content: string }>
): string =>
  scripts
    .map(script => `${script.id}:${script.title}:${script.status ?? ''}:${script.content.length}`)
    .join('|')

// ---------------------------------------------------------------------------
// localStorage persistence, all failure-tolerant

const readJson = <T>(key: string): T | null => {
  try {
    const item = window.localStorage.getItem(key)
    return item ? (JSON.parse(item) as T) : null
  } catch {
    return null
  }
}

const writeJson = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.error(`Error saving ${key} to localStorage:`, error)
  }
}

const removeKey = (key: string) => {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing to do — the key is best-effort state
  }
}

export const loadExportSnapshot = (): ExportSnapshot | null => {
  const parsed = readJson<ExportSnapshot>(EXPORT_SNAPSHOT_KEY)
  if (!parsed || typeof parsed.exportedAt !== 'number' || !Array.isArray(parsed.scriptIds)) {
    return null
  }
  return {
    exportedAt: parsed.exportedAt,
    scriptIds: parsed.scriptIds.filter((id): id is string => typeof id === 'string')
  }
}

export const recordLibraryExported = (scriptIds: string[], now: number): ExportSnapshot => {
  const snapshot: ExportSnapshot = { exportedAt: now, scriptIds }
  writeJson(EXPORT_SNAPSHOT_KEY, snapshot)
  removeKey(REMINDER_DISMISSAL_KEY)
  return snapshot
}

export const loadReminderDismissal = (): ReminderDismissal | null => {
  const parsed = readJson<ReminderDismissal>(REMINDER_DISMISSAL_KEY)
  if (!parsed || typeof parsed.dismissedAt !== 'number' || typeof parsed.newScriptCount !== 'number') {
    return null
  }
  return parsed
}

export const recordReminderDismissed = (newScriptCount: number, now: number): ReminderDismissal => {
  const dismissal: ReminderDismissal = { dismissedAt: now, newScriptCount }
  writeJson(REMINDER_DISMISSAL_KEY, dismissal)
  return dismissal
}

export const loadReminderEnabled = (): boolean => {
  const parsed = readJson<boolean>(REMINDER_ENABLED_KEY)
  return parsed === null ? true : parsed === true
}

export const saveReminderEnabled = (enabled: boolean) => {
  writeJson(REMINDER_ENABLED_KEY, enabled)
}

export const AUTO_BACKUP_ENABLED_KEY = 'autoBackupEnabled'

export const loadAutoBackupEnabled = (): boolean =>
  readJson<boolean>(AUTO_BACKUP_ENABLED_KEY) === true

export const saveAutoBackupEnabled = (enabled: boolean) => {
  writeJson(AUTO_BACKUP_ENABLED_KEY, enabled)
}

export const loadAutoBackupLastWrittenAt = (): number | null => {
  const parsed = readJson<number>(AUTO_BACKUP_LAST_WRITTEN_KEY)
  return typeof parsed === 'number' ? parsed : null
}

export const loadAutoBackupSignature = (): string | null => {
  const parsed = readJson<string>(AUTO_BACKUP_SIGNATURE_KEY)
  return typeof parsed === 'string' ? parsed : null
}

export const recordAutoBackupWritten = (signature: string, now: number) => {
  writeJson(AUTO_BACKUP_LAST_WRITTEN_KEY, now)
  writeJson(AUTO_BACKUP_SIGNATURE_KEY, signature)
}
