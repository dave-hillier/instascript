// Linked backup folder (story 7.4): where the File System Access API is
// available, the user can link a local folder that automatically receives
// the library export after significant changes. The directory handle is
// persisted in IndexedDB so the link survives reloads; every step degrades
// gracefully — a failure just means no automatic backup, never an error
// surfaced mid-generation. Strictly local: nothing leaves the device.

export const BACKUP_FILENAME = 'instascript-library-backup.json'

const DB_NAME = 'instascript-backup'
const DB_VERSION = 1
const STORE_NAME = 'handles'
const HANDLE_KEY = 'backupFolder'

// The feature only appears where the browser can both pick a directory and
// persist its handle
export const isBackupFolderSupported = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.showDirectoryPicker === 'function' &&
  typeof window.indexedDB !== 'undefined'

// Opens the browser's directory picker. Resolves null when the user cancels
// or the API is unavailable.
export const pickBackupFolder = async (): Promise<FileSystemDirectoryHandle | null> => {
  if (typeof window.showDirectoryPicker !== 'function') return null
  try {
    return await window.showDirectoryPicker({ id: 'instascript-backup', mode: 'readwrite' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    console.error('Error picking backup folder:', error)
    return null
  }
}

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })

const withStore = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode)
      const request = operation(transaction.objectStore(STORE_NAME))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
  } finally {
    db.close()
  }
}

export const storeBackupFolderHandle = async (handle: FileSystemDirectoryHandle): Promise<boolean> => {
  try {
    await withStore('readwrite', store => store.put(handle, HANDLE_KEY))
    return true
  } catch (error) {
    // Some browsers cannot structured-clone handles into IndexedDB; the link
    // then lasts for the session only
    console.error('Error persisting backup folder handle:', error)
    return false
  }
}

export const loadBackupFolderHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  try {
    const stored = await withStore<unknown>('readonly', store => store.get(HANDLE_KEY))
    if (stored && typeof stored === 'object' && 'getFileHandle' in stored) {
      return stored as FileSystemDirectoryHandle
    }
    return null
  } catch {
    return null
  }
}

export const clearBackupFolderHandle = async (): Promise<void> => {
  try {
    await withStore('readwrite', store => store.delete(HANDLE_KEY))
  } catch {
    // Best effort — an unlinked folder that lingers in IndexedDB is harmless
  }
}

// Checks (and optionally requests) readwrite permission on the handle. Where
// the permission API is missing, assume granted and let the write attempt
// itself be the test.
export const ensureBackupPermission = async (
  handle: FileSystemDirectoryHandle,
  withPrompt: boolean
): Promise<boolean> => {
  try {
    const descriptor: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission(descriptor)
      if (state === 'granted') return true
      if (!withPrompt || typeof handle.requestPermission !== 'function') return false
      return (await handle.requestPermission(descriptor)) === 'granted'
    }
    return true
  } catch {
    return false
  }
}

// Writes the export into the linked folder under a stable filename, so the
// backup is one file that always holds the latest state
export const writeBackupFile = async (
  handle: FileSystemDirectoryHandle,
  contents: string
): Promise<void> => {
  const fileHandle = await handle.getFileHandle(BACKUP_FILENAME, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(contents)
  await writable.close()
}
