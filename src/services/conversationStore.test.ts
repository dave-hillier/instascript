import { describe, it, expect } from 'vitest'
import type { RawConversation } from '../types/conversation'
import {
  QueuedConversationStore,
  OpfsConversationBackend,
  LocalStorageConversationBackend,
  type ConversationBackend,
  type DirectoryHandle,
  type FileHandle,
  type KeyValueStore
} from './conversationStore'
import { serializeConversationToYamlMarkdown } from './conversationParser'

class FakeFileHandle implements FileHandle {
  private files: Map<string, string>
  private name: string

  constructor(files: Map<string, string>, name: string) {
    this.files = files
    this.name = name
  }

  async getFile() {
    const content = this.files.get(this.name) ?? ''
    return { text: async () => content }
  }

  async createWritable() {
    const files = this.files
    const name = this.name
    let buffer = ''
    return {
      write: async (data: string) => {
        buffer += data
      },
      close: async () => {
        files.set(name, buffer)
      }
    }
  }
}

class FakeDirectoryHandle implements DirectoryHandle {
  files = new Map<string, string>()

  async *keys(): AsyncIterable<string> {
    yield* [...this.files.keys()]
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new Error(`File not found: ${name}`)
      this.files.set(name, '')
    }
    return new FakeFileHandle(this.files, name)
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name)
  }
}

class FakeKeyValueStore implements KeyValueStore {
  private map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  keys(): string[] {
    return [...this.map.keys()]
  }
}

const makeConversation = (scriptId: string): RawConversation => ({
  id: `conv_${scriptId}`,
  scriptId,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  generations: [
    {
      messages: [{ role: 'user', content: 'Write me a relaxing script' }],
      response: '## Induction\n\nBreathe in slowly and let the day soften.',
      timestamp: 1700000000500,
      cachedTokens: 42
    },
    {
      messages: [
        { role: 'user', content: 'Write me a relaxing script' },
        { role: 'assistant', content: '## Induction\n\nBreathe in slowly and let the day soften.' },
        { role: 'user', content: 'Continue with the next section' }
      ],
      response: '## Deepening\n\nEach breath carries you further down.',
      timestamp: 1700000000900,
      exampleIds: ['ex-1', 'ex-2']
    }
  ]
})

const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('QueuedConversationStore with an OPFS directory fake', () => {
  it('round-trips a conversation through serialization and back', async () => {
    const directory = new FakeDirectoryHandle()
    const store = new QueuedConversationStore(new OpfsConversationBackend(directory))
    const conversation = makeConversation('script_abc')

    await store.save(conversation)
    const loaded = await store.loadAll()

    expect(loaded).toHaveLength(1)
    const restored = loaded[0]
    expect(restored.id).toBe(conversation.id)
    expect(restored.scriptId).toBe(conversation.scriptId)
    expect(restored.createdAt).toBe(conversation.createdAt)
    expect(restored.updatedAt).toBe(conversation.updatedAt)
    expect(restored.generations).toHaveLength(2)
    expect(restored.generations[0].response).toBe(conversation.generations[0].response)
    expect(restored.generations[0].cachedTokens).toBe(42)
    expect(restored.generations[1].response).toBe(conversation.generations[1].response)
    expect(restored.generations[1].exampleIds).toEqual(['ex-1', 'ex-2'])
    // The serializer stores each generation's initial user prompt and response
    expect(restored.generations[0].messages[0]).toEqual({
      role: 'user',
      content: 'Write me a relaxing script'
    })
  })

  it('stores one file per conversation', async () => {
    const directory = new FakeDirectoryHandle()
    const store = new QueuedConversationStore(new OpfsConversationBackend(directory))

    await store.save(makeConversation('script_one'))
    await store.save(makeConversation('script_two'))

    expect([...directory.files.keys()].sort()).toEqual(['script_one.md', 'script_two.md'])
  })

  it('overwrites the same file on repeated saves of one conversation', async () => {
    const directory = new FakeDirectoryHandle()
    const store = new QueuedConversationStore(new OpfsConversationBackend(directory))
    const conversation = makeConversation('script_abc')

    await store.save(conversation)
    const updated = {
      ...conversation,
      generations: conversation.generations.slice(0, 1),
      updatedAt: 1700000002000
    }
    await store.save(updated)

    expect(directory.files.size).toBe(1)
    const loaded = await store.loadAll()
    expect(loaded[0].generations).toHaveLength(1)
    expect(loaded[0].updatedAt).toBe(1700000002000)
  })

  it('skips conversations without a scriptId', async () => {
    const directory = new FakeDirectoryHandle()
    const store = new QueuedConversationStore(new OpfsConversationBackend(directory))

    await store.save({ ...makeConversation('script_abc'), scriptId: '' })

    expect(directory.files.size).toBe(0)
  })

  it('clearAll removes every stored file', async () => {
    const directory = new FakeDirectoryHandle()
    const store = new QueuedConversationStore(new OpfsConversationBackend(directory))

    await store.save(makeConversation('script_one'))
    await store.save(makeConversation('script_two'))
    await store.clearAll()

    expect(directory.files.size).toBe(0)
    expect(await store.loadAll()).toEqual([])
  })
})

describe('QueuedConversationStore write queue', () => {
  it('serializes writes so they never interleave', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const backend: ConversationBackend = {
      readAll: async () => [],
      write: async (scriptId: string) => {
        order.push(`start:${scriptId}`)
        if (scriptId === 'script_a') {
          await new Promise<void>(resolve => {
            releaseFirst = resolve
          })
        }
        order.push(`end:${scriptId}`)
      },
      clear: async () => {}
    }
    const store = new QueuedConversationStore(backend)

    const first = store.save(makeConversation('script_a'))
    const second = store.save(makeConversation('script_b'))
    await flushMicrotasks()

    // The second write must not begin while the first is in flight
    expect(order).toEqual(['start:script_a'])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['start:script_a', 'end:script_a', 'start:script_b', 'end:script_b'])
  })

  it('keeps accepting writes after one fails', async () => {
    const written: string[] = []
    let shouldFail = true
    const backend: ConversationBackend = {
      readAll: async () => [],
      write: async (scriptId: string) => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('disk on fire')
        }
        written.push(scriptId)
      },
      clear: async () => {}
    }
    const store = new QueuedConversationStore(backend)

    await expect(store.save(makeConversation('script_a'))).rejects.toThrow('disk on fire')
    await store.save(makeConversation('script_b'))

    expect(written).toEqual(['script_b'])
  })

  it('queues clearAll behind pending saves', async () => {
    const order: string[] = []
    const directory = new FakeDirectoryHandle()
    const backend = new OpfsConversationBackend(directory)
    const trackingBackend: ConversationBackend = {
      readAll: () => backend.readAll(),
      write: async (scriptId, content) => {
        await backend.write(scriptId, content)
        order.push(`write:${scriptId}`)
      },
      clear: async () => {
        await backend.clear()
        order.push('clear')
      }
    }
    const store = new QueuedConversationStore(trackingBackend)

    const save = store.save(makeConversation('script_a'))
    const clear = store.clearAll()
    await Promise.all([save, clear])

    expect(order).toEqual(['write:script_a', 'clear'])
    expect(directory.files.size).toBe(0)
  })
})

describe('migration from localStorage to OPFS', () => {
  it('moves conversation_* keys into the backend and removes them', async () => {
    const directory = new FakeDirectoryHandle()
    const legacy = new FakeKeyValueStore()
    const conversation = makeConversation('script_legacy')
    legacy.setItem('conversation_script_legacy', serializeConversationToYamlMarkdown(conversation))
    legacy.setItem('theme', 'dark')

    const store = new QueuedConversationStore(new OpfsConversationBackend(directory), legacy)
    const loaded = await store.loadAll()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(conversation.id)
    expect(legacy.getItem('conversation_script_legacy')).toBeNull()
    expect(legacy.getItem('theme')).toBe('dark')
    expect(directory.files.has('script_legacy.md')).toBe(true)
  })

  it('migrates the oldest single-JSON format through to the backend', async () => {
    const directory = new FakeDirectoryHandle()
    const legacy = new FakeKeyValueStore()
    const conversation = makeConversation('script_json_era')
    legacy.setItem('conversations', JSON.stringify([conversation]))

    const store = new QueuedConversationStore(new OpfsConversationBackend(directory), legacy)
    const loaded = await store.loadAll()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].scriptId).toBe('script_json_era')
    expect(legacy.getItem('conversations')).toBeNull()
    expect(legacy.keys()).toEqual([])
  })

  it('keeps the localStorage copy when the backend write fails', async () => {
    const legacy = new FakeKeyValueStore()
    const content = serializeConversationToYamlMarkdown(makeConversation('script_x'))
    legacy.setItem('conversation_script_x', content)
    const backend: ConversationBackend = {
      readAll: async () => [],
      write: async () => {
        throw new Error('quota exceeded')
      },
      clear: async () => {}
    }

    const store = new QueuedConversationStore(backend, legacy)
    await store.loadAll()

    expect(legacy.getItem('conversation_script_x')).toBe(content)
  })
})

describe('LocalStorageConversationBackend fallback', () => {
  it('round-trips conversations through the same store interface', async () => {
    const legacy = new FakeKeyValueStore()
    const store = new QueuedConversationStore(new LocalStorageConversationBackend(legacy))
    const conversation = makeConversation('script_fallback')

    await store.save(conversation)
    const loaded = await store.loadAll()

    expect(legacy.getItem('conversation_script_fallback')).not.toBeNull()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe(conversation.id)
    expect(loaded[0].generations).toHaveLength(2)
  })

  it('clearAll removes only conversation keys', async () => {
    const legacy = new FakeKeyValueStore()
    legacy.setItem('theme', 'dark')
    const store = new QueuedConversationStore(new LocalStorageConversationBackend(legacy))

    await store.save(makeConversation('script_fallback'))
    await store.clearAll()

    expect(legacy.keys()).toEqual(['theme'])
  })
})
