import { describe, it, expect } from 'vitest'
import {
  countNewScripts,
  evaluateBackupReminder,
  shouldWriteAutoBackup,
  autoBackupDelay,
  librarySignature,
  NEW_SCRIPTS_BEFORE_REMINDER,
  STALE_EXPORT_AFTER_MS,
  REMIND_AGAIN_AFTER_MS,
  AUTO_BACKUP_THROTTLE_MS,
  type ExportSnapshot
} from '../backupReminder'

const NOW = 1_750_000_000_000
const DAY = 24 * 60 * 60 * 1000

const snapshotOf = (scriptIds: string[], exportedAt = NOW - DAY): ExportSnapshot => ({
  exportedAt,
  scriptIds
})

describe('countNewScripts', () => {
  it('counts everything as new when the library has never been exported', () => {
    expect(countNewScripts(null, ['a', 'b', 'c'])).toBe(3)
  })

  it('counts only scripts absent from the last export', () => {
    expect(countNewScripts(snapshotOf(['a', 'b']), ['a', 'b', 'c', 'd'])).toBe(2)
  })

  it('is zero when nothing has changed since the export', () => {
    expect(countNewScripts(snapshotOf(['a', 'b']), ['a', 'b'])).toBe(0)
  })

  it('ignores scripts that were exported but since deleted', () => {
    expect(countNewScripts(snapshotOf(['a', 'b', 'c']), ['a'])).toBe(0)
  })
})

describe('evaluateBackupReminder', () => {
  const base = {
    enabled: true,
    snapshot: null as ExportSnapshot | null,
    currentScriptIds: [] as string[],
    dismissal: null,
    now: NOW
  }

  it('is never due when the reminder is disabled in settings', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    expect(evaluateBackupReminder({ ...base, enabled: false, currentScriptIds: ids }).due).toBe(false)
  })

  it('is not due for an empty library', () => {
    expect(evaluateBackupReminder({ ...base }).due).toBe(false)
  })

  it('is not due below the new-script threshold when the export is recent', () => {
    const result = evaluateBackupReminder({
      ...base,
      snapshot: snapshotOf(['a']),
      currentScriptIds: ['a', 'b', 'c']
    })
    expect(result.due).toBe(false)
    expect(result.newScriptCount).toBe(2)
  })

  it('becomes due once enough new scripts accrue', () => {
    const result = evaluateBackupReminder({
      ...base,
      snapshot: snapshotOf(['a']),
      currentScriptIds: ['a', 'b', 'c', 'd']
    })
    expect(result.due).toBe(true)
    expect(result.newScriptCount).toBe(NEW_SCRIPTS_BEFORE_REMINDER)
    expect(result.lastExportedAt).toBe(NOW - DAY)
  })

  it('is due for a never-exported library at the threshold', () => {
    expect(
      evaluateBackupReminder({ ...base, currentScriptIds: ['a', 'b', 'c'] }).due
    ).toBe(true)
  })

  it('treats an old export as stale even with a single new script', () => {
    const result = evaluateBackupReminder({
      ...base,
      snapshot: snapshotOf(['a'], NOW - STALE_EXPORT_AFTER_MS),
      currentScriptIds: ['a', 'b']
    })
    expect(result.due).toBe(true)
  })

  it('does not nag about an old export when no new work exists', () => {
    const result = evaluateBackupReminder({
      ...base,
      snapshot: snapshotOf(['a'], NOW - STALE_EXPORT_AFTER_MS * 2),
      currentScriptIds: ['a']
    })
    expect(result.due).toBe(false)
  })

  it('stays quiet after a dismissal while no further work accrues', () => {
    const result = evaluateBackupReminder({
      ...base,
      currentScriptIds: ['a', 'b', 'c'],
      dismissal: { dismissedAt: NOW - DAY, newScriptCount: 3 }
    })
    expect(result.due).toBe(false)
  })

  it('returns after a dismissal once more scripts accrue', () => {
    const result = evaluateBackupReminder({
      ...base,
      currentScriptIds: ['a', 'b', 'c', 'd'],
      dismissal: { dismissedAt: NOW - DAY, newScriptCount: 3 }
    })
    expect(result.due).toBe(true)
  })

  it('returns once a dismissal has expired even without new work', () => {
    const result = evaluateBackupReminder({
      ...base,
      currentScriptIds: ['a', 'b', 'c'],
      dismissal: { dismissedAt: NOW - REMIND_AGAIN_AFTER_MS, newScriptCount: 3 }
    })
    expect(result.due).toBe(true)
  })

  it('exporting resets the count and silences the reminder', () => {
    const result = evaluateBackupReminder({
      ...base,
      snapshot: snapshotOf(['a', 'b', 'c', 'd'], NOW),
      currentScriptIds: ['a', 'b', 'c', 'd']
    })
    expect(result.due).toBe(false)
    expect(result.newScriptCount).toBe(0)
  })
})

describe('shouldWriteAutoBackup', () => {
  it('writes immediately when nothing has been written yet', () => {
    expect(shouldWriteAutoBackup(null, NOW)).toBe(true)
  })

  it('throttles writes inside the interval', () => {
    expect(shouldWriteAutoBackup(NOW - AUTO_BACKUP_THROTTLE_MS + 1, NOW)).toBe(false)
  })

  it('allows a write once the interval has elapsed', () => {
    expect(shouldWriteAutoBackup(NOW - AUTO_BACKUP_THROTTLE_MS, NOW)).toBe(true)
  })
})

describe('autoBackupDelay', () => {
  it('is zero when no write has happened yet', () => {
    expect(autoBackupDelay(null, NOW)).toBe(0)
  })

  it('is the remaining throttle time after a recent write', () => {
    expect(autoBackupDelay(NOW - 60_000, NOW)).toBe(AUTO_BACKUP_THROTTLE_MS - 60_000)
  })

  it('is zero once the throttle has elapsed', () => {
    expect(autoBackupDelay(NOW - AUTO_BACKUP_THROTTLE_MS * 2, NOW)).toBe(0)
  })
})

describe('librarySignature', () => {
  const script = { id: 'a', title: 'One', status: 'complete', content: 'hello' }

  it('is stable for identical libraries', () => {
    expect(librarySignature([script])).toBe(librarySignature([{ ...script }]))
  })

  it('changes when content grows', () => {
    expect(librarySignature([script])).not.toBe(
      librarySignature([{ ...script, content: 'hello world' }])
    )
  })

  it('changes when a script is added', () => {
    expect(librarySignature([script])).not.toBe(
      librarySignature([script, { id: 'b', title: 'Two', content: '' }])
    )
  })

  it('changes when a title or status changes', () => {
    expect(librarySignature([script])).not.toBe(librarySignature([{ ...script, title: 'Renamed' }]))
    expect(librarySignature([script])).not.toBe(librarySignature([{ ...script, status: 'draft' }]))
  })
})
