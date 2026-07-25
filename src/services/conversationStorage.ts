import type { RawConversation, Generation, ChatMessage } from '../types/conversation'
import {
  QueuedConversationStore,
  OpfsConversationBackend,
  LocalStorageConversationBackend,
  type ConversationStore,
  type DirectoryHandle,
  type KeyValueStore
} from './conversationStore'

const browserLocalStorage: KeyValueStore = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    window.localStorage.setItem(key, value)
  },
  removeItem: (key) => {
    window.localStorage.removeItem(key)
  },
  keys: () => Object.keys(window.localStorage)
}

// Feature-detect the Origin Private File System. Returns the app's
// conversations directory, or null when OPFS (or writable-stream support,
// missing in older Safari) is unavailable.
const openConversationsDirectory = async (): Promise<DirectoryHandle | null> => {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return null
    }
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('conversations', { create: true })
    const probe = await directory.getFileHandle('.probe', { create: true })
    const supportsWritableStreams =
      typeof (probe as { createWritable?: unknown }).createWritable === 'function'
    await directory.removeEntry('.probe')
    if (!supportsWritableStreams) return null
    return directory as unknown as DirectoryHandle
  } catch {
    return null
  }
}

let storePromise: Promise<ConversationStore> | null = null

// Lazily selects OPFS with localStorage migration, or falls back to
// localStorage transparently behind the same interface.
export const getConversationStore = (): Promise<ConversationStore> => {
  if (!storePromise) {
    storePromise = openConversationsDirectory().then(directory =>
      directory
        ? new QueuedConversationStore(new OpfsConversationBackend(directory), browserLocalStorage)
        : new QueuedConversationStore(new LocalStorageConversationBackend(browserLocalStorage))
    )
  }
  return storePromise
}

export const loadStoredConversations = async (): Promise<RawConversation[]> => {
  try {
    const store = await getConversationStore()
    return await store.loadAll()
  } catch (error) {
    console.warn('Error loading conversations:', error)
    return []
  }
}

// Non-blocking: enqueues the write and returns immediately, so throttled
// saves during streaming never block the main thread.
export const saveStoredConversation = (conversation: RawConversation): void => {
  void getConversationStore()
    .then(store => store.save(conversation))
    .catch(error => {
      console.error('Error saving conversation:', error)
    })
}

export const clearStoredConversations = async (): Promise<void> => {
  try {
    const store = await getConversationStore()
    await store.clearAll()
  } catch (error) {
    console.error('Error clearing conversations:', error)
  }
}

// Helper functions for working with generations
export const addGenerationToConversation = (
  conversations: RawConversation[],
  conversationId: string,
  generation: Generation
): RawConversation[] => {
  return conversations.map(conv =>
    conv.id === conversationId
      ? { ...conv, generations: [...conv.generations, generation], updatedAt: Date.now() }
      : conv
  )
}

export const updateLatestGeneration = (
  conversations: RawConversation[],
  conversationId: string,
  response: string,
  cachedTokens?: number
): RawConversation[] => {
  return conversations.map(conv =>
    conv.id === conversationId && conv.generations.length > 0
      ? {
          ...conv,
          generations: [
            ...conv.generations.slice(0, -1),
            {
              ...conv.generations[conv.generations.length - 1],
              response,
              cachedTokens
            }
          ],
          updatedAt: Date.now()
        }
      : conv
  )
}

export const createRawConversation = (
  scriptId: string
): RawConversation => {
  return {
    id: `conv_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    scriptId,
    generations: [], // Will be populated when first generation is created
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

// Builds a new conversation for a duplicated script, seeded with deep
// copies of the source conversation's generations so the copy renders and
// regenerates independently of the original. A missing source yields an
// empty conversation.
export const duplicateRawConversation = (
  source: RawConversation | undefined,
  newScriptId: string
): RawConversation => {
  return {
    ...createRawConversation(newScriptId),
    generations: source ? structuredClone(source.generations) : []
  }
}

export const getLatestGeneration = (conversation: RawConversation): Generation | undefined => {
  if (!conversation.generations || conversation.generations.length === 0) return undefined
  return conversation.generations[conversation.generations.length - 1]
}

export const getLatestResponse = (conversation: RawConversation): string => {
  const latest = getLatestGeneration(conversation)
  return latest?.response || ''
}

export const getLatestMessages = (conversation: RawConversation): ChatMessage[] => {
  const latest = getLatestGeneration(conversation)
  return latest?.messages || []
}
