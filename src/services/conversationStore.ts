import type { RawConversation } from '../types/conversation'
import { parseConversationFromYamlMarkdown, serializeConversationToYamlMarkdown, migrateJsonToYamlMarkdown } from './conversationParser'

// Minimal structural types covering the slice of the OPFS API this store
// uses, so the store can be exercised in tests with an in-memory fake
// directory handle and so the real FileSystemDirectoryHandle can be passed
// without depending on lib.dom's coverage of the async-iteration methods.
export interface StoredFile {
  text(): Promise<string>
}

export interface WritableFile {
  write(data: string): Promise<void>
  close(): Promise<void>
}

export interface FileHandle {
  getFile(): Promise<StoredFile>
  createWritable(): Promise<WritableFile>
}

export interface DirectoryHandle {
  keys(): AsyncIterable<string>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>
  removeEntry(name: string): Promise<void>
}

// Minimal synchronous key-value surface matching window.localStorage, kept
// injectable so migration and the fallback backend are testable.
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys(): string[]
}

export interface ConversationStore {
  loadAll(): Promise<RawConversation[]>
  save(conversation: RawConversation): Promise<void>
  clearAll(): Promise<void>
}

export interface ConversationBackend {
  readAll(): Promise<string[]>
  write(scriptId: string, content: string): Promise<void>
  clear(): Promise<void>
}

const LEGACY_KEY_PREFIX = 'conversation_'
const LEGACY_JSON_KEY = 'conversations'
const FILE_SUFFIX = '.md'

const fileNameForScript = (scriptId: string): string =>
  `${encodeURIComponent(scriptId)}${FILE_SUFFIX}`

// Converts the pre-YAML single-JSON-blob format into per-conversation
// YAML/markdown entries inside the same key-value store.
export const migrateLegacyJsonKey = (storage: KeyValueStore): void => {
  const oldJson = storage.getItem(LEGACY_JSON_KEY)
  if (!oldJson) return
  try {
    const migrated = migrateJsonToYamlMarkdown(JSON.parse(oldJson) as RawConversation[])
    for (const [key, content] of migrated) {
      storage.setItem(key, content)
    }
  } catch (error) {
    console.warn('Could not migrate legacy conversations JSON:', error)
  }
  storage.removeItem(LEGACY_JSON_KEY)
}

export class OpfsConversationBackend implements ConversationBackend {
  private directory: DirectoryHandle

  constructor(directory: DirectoryHandle) {
    this.directory = directory
  }

  async readAll(): Promise<string[]> {
    const contents: string[] = []
    for await (const name of this.directory.keys()) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      const handle = await this.directory.getFileHandle(name)
      const file = await handle.getFile()
      contents.push(await file.text())
    }
    return contents
  }

  async write(scriptId: string, content: string): Promise<void> {
    const handle = await this.directory.getFileHandle(fileNameForScript(scriptId), { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
  }

  async clear(): Promise<void> {
    const names: string[] = []
    for await (const name of this.directory.keys()) {
      names.push(name)
    }
    for (const name of names) {
      await this.directory.removeEntry(name)
    }
  }
}

export class LocalStorageConversationBackend implements ConversationBackend {
  private storage: KeyValueStore

  constructor(storage: KeyValueStore) {
    this.storage = storage
  }

  async readAll(): Promise<string[]> {
    migrateLegacyJsonKey(this.storage)
    const contents: string[] = []
    for (const key of this.storage.keys()) {
      if (!key.startsWith(LEGACY_KEY_PREFIX)) continue
      const content = this.storage.getItem(key)
      if (content) contents.push(content)
    }
    return contents
  }

  async write(scriptId: string, content: string): Promise<void> {
    this.storage.setItem(`${LEGACY_KEY_PREFIX}${scriptId}`, content)
  }

  async clear(): Promise<void> {
    for (const key of this.storage.keys()) {
      if (key.startsWith(LEGACY_KEY_PREFIX)) {
        this.storage.removeItem(key)
      }
    }
  }
}

// Serializes all writes through a promise chain so saves fired during
// streaming never interleave, while callers remain free to fire-and-forget.
export class QueuedConversationStore implements ConversationStore {
  private backend: ConversationBackend
  private legacyStorage?: KeyValueStore
  private tail: Promise<void> = Promise.resolve()

  constructor(backend: ConversationBackend, legacyStorage?: KeyValueStore) {
    this.backend = backend
    this.legacyStorage = legacyStorage
  }

  async loadAll(): Promise<RawConversation[]> {
    await this.migrateLegacyStorage()
    const contents = await this.backend.readAll()
    const conversations: RawConversation[] = []
    for (const content of contents) {
      const parsed = parseConversationFromYamlMarkdown(content)
      if (parsed) conversations.push(parsed)
    }
    return conversations
  }

  save(conversation: RawConversation): Promise<void> {
    if (!conversation.scriptId) return Promise.resolve()
    const scriptId = conversation.scriptId
    const content = serializeConversationToYamlMarkdown(conversation)
    return this.enqueue(() => this.backend.write(scriptId, content))
  }

  clearAll(): Promise<void> {
    return this.enqueue(() => this.backend.clear())
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.tail.then(task)
    // Keep the chain alive after a failed write; the returned promise still
    // rejects for callers that choose to await it.
    this.tail = result.catch(error => {
      console.error('Conversation storage write failed:', error)
    })
    return result
  }

  // Moves any conversations left in localStorage into the backend, removing
  // each key only once its content has been written successfully.
  private async migrateLegacyStorage(): Promise<void> {
    const legacy = this.legacyStorage
    if (!legacy) return
    migrateLegacyJsonKey(legacy)
    for (const key of legacy.keys()) {
      if (!key.startsWith(LEGACY_KEY_PREFIX)) continue
      const content = legacy.getItem(key)
      if (content) {
        try {
          await this.backend.write(key.slice(LEGACY_KEY_PREFIX.length), content)
        } catch (error) {
          console.warn(`Could not migrate ${key} to OPFS:`, error)
          continue
        }
      }
      legacy.removeItem(key)
    }
  }
}
