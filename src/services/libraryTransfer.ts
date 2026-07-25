// Export/import of the whole library (story 7.2): one JSON file containing
// all scripts and conversations. Parsing validates the shape and merging
// skips anything whose id is already present, so an import never duplicates
// or overwrites existing work.

import type { Script } from '../types/script'
import type { RawConversation, Generation, ChatMessage } from '../types/conversation'

export const LIBRARY_EXPORT_FORMAT = 'instascript-library'
export const LIBRARY_EXPORT_VERSION = 1

export interface LibraryExport {
  format: typeof LIBRARY_EXPORT_FORMAT
  version: number
  exportedAt: string
  scripts: Script[]
  conversations: RawConversation[]
}

export interface LibraryImportCounts {
  scriptsImported: number
  scriptsSkipped: number
  conversationsImported: number
  conversationsSkipped: number
}

export interface LibraryMergeResult extends LibraryImportCounts {
  newScripts: Script[]
  newConversations: RawConversation[]
}

// The subset of existing state a merge needs to detect collisions. Stored
// conversations are keyed by scriptId, so a conversation is also a duplicate
// when another conversation already covers its script.
export interface ExistingLibrary {
  scriptIds: Iterable<string>
  conversations: Iterable<{ id: string; scriptId: string }>
}

export const buildLibraryExport = (
  scripts: Script[],
  conversations: RawConversation[]
): LibraryExport => ({
  format: LIBRARY_EXPORT_FORMAT,
  version: LIBRARY_EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  scripts,
  conversations
})

export const serializeLibraryExport = (
  scripts: Script[],
  conversations: RawConversation[]
): string => JSON.stringify(buildLibraryExport(scripts, conversations), null, 2)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const validateScript = (value: unknown, index: number): Script => {
  if (!isRecord(value)) {
    throw new Error(`Script at position ${index + 1} is not an object`)
  }
  if (!isNonEmptyString(value.id)) {
    throw new Error(`Script at position ${index + 1} is missing an id`)
  }
  if (typeof value.title !== 'string') {
    throw new Error(`Script "${value.id}" is missing a title`)
  }
  return {
    id: value.id,
    title: value.title,
    content: typeof value.content === 'string' ? value.content : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    isArchived: value.isArchived === true,
    tags: Array.isArray(value.tags) ? value.tags.filter(isNonEmptyString) : undefined,
    status: value.status === 'draft' || value.status === 'complete' || value.status === 'in-progress'
      ? value.status
      : undefined,
    length: typeof value.length === 'string' ? value.length : undefined,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : undefined,
    initialPrompt: typeof value.initialPrompt === 'string' ? value.initialPrompt : undefined,
    provider: typeof value.provider === 'string' ? value.provider : undefined,
    model: typeof value.model === 'string' ? value.model : undefined
  }
}

const validateMessage = (value: unknown): ChatMessage | null => {
  if (!isRecord(value)) return null
  if (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant') return null
  if (typeof value.content !== 'string') return null
  return { role: value.role, content: value.content }
}

const validateGeneration = (value: unknown, conversationId: string): Generation => {
  if (!isRecord(value)) {
    throw new Error(`Conversation "${conversationId}" has a malformed generation`)
  }
  if (!Array.isArray(value.messages)) {
    throw new Error(`Conversation "${conversationId}" has a generation without messages`)
  }
  const messages = value.messages.map(validateMessage)
  if (messages.some(message => message === null)) {
    throw new Error(`Conversation "${conversationId}" has a malformed message`)
  }
  return {
    messages: messages as ChatMessage[],
    response: typeof value.response === 'string' ? value.response : '',
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.now(),
    cachedTokens: typeof value.cachedTokens === 'number' ? value.cachedTokens : undefined,
    exampleIds: Array.isArray(value.exampleIds) ? value.exampleIds.filter(isNonEmptyString) : undefined
  }
}

const validateConversation = (value: unknown, index: number): RawConversation => {
  if (!isRecord(value)) {
    throw new Error(`Conversation at position ${index + 1} is not an object`)
  }
  if (!isNonEmptyString(value.id)) {
    throw new Error(`Conversation at position ${index + 1} is missing an id`)
  }
  if (!isNonEmptyString(value.scriptId)) {
    throw new Error(`Conversation "${value.id}" is missing its scriptId`)
  }
  if (!Array.isArray(value.generations)) {
    throw new Error(`Conversation "${value.id}" is missing its generations`)
  }
  return {
    id: value.id,
    scriptId: value.scriptId,
    generations: value.generations.map(generation => validateGeneration(generation, value.id as string)),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now()
  }
}

// Parses and validates an exported library file. Throws an Error whose
// message names the first problem found, for inline display in settings.
export const parseLibraryExport = (json: string): LibraryExport => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('The file is not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw new Error('The file is not a library export')
  }
  if (parsed.format !== LIBRARY_EXPORT_FORMAT) {
    throw new Error('The file is not an InstaScript library export')
  }
  if (!Array.isArray(parsed.scripts) || !Array.isArray(parsed.conversations)) {
    throw new Error('The export is missing its scripts or conversations list')
  }
  return {
    format: LIBRARY_EXPORT_FORMAT,
    version: typeof parsed.version === 'number' ? parsed.version : LIBRARY_EXPORT_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    scripts: parsed.scripts.map(validateScript),
    conversations: parsed.conversations.map(validateConversation)
  }
}

// Splits an imported library into what is new and what already exists.
// Duplicates within the imported file itself are also collapsed.
export const mergeLibrary = (
  imported: LibraryExport,
  existing: ExistingLibrary
): LibraryMergeResult => {
  const knownScriptIds = new Set(existing.scriptIds)
  const knownConversationIds = new Set<string>()
  const coveredScriptIds = new Set<string>()
  for (const conversation of existing.conversations) {
    knownConversationIds.add(conversation.id)
    coveredScriptIds.add(conversation.scriptId)
  }

  const newScripts: Script[] = []
  let scriptsSkipped = 0
  for (const script of imported.scripts) {
    if (knownScriptIds.has(script.id)) {
      scriptsSkipped++
      continue
    }
    knownScriptIds.add(script.id)
    newScripts.push(script)
  }

  const newConversations: RawConversation[] = []
  let conversationsSkipped = 0
  for (const conversation of imported.conversations) {
    // Conversations persist one-per-script, so a second conversation for a
    // script already covered would overwrite it — treat that as a duplicate
    if (knownConversationIds.has(conversation.id) || coveredScriptIds.has(conversation.scriptId)) {
      conversationsSkipped++
      continue
    }
    knownConversationIds.add(conversation.id)
    coveredScriptIds.add(conversation.scriptId)
    newConversations.push(conversation)
  }

  return {
    newScripts,
    newConversations,
    scriptsImported: newScripts.length,
    scriptsSkipped,
    conversationsImported: newConversations.length,
    conversationsSkipped
  }
}
