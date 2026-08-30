import YAML from 'yaml'
import type {
  RawConversation,
  Generation,
  ChatMessage,
  GenerationToolCall
} from '../types/conversation'
import {
  GROUNDING_SELECT_TOOL,
  OUTLINE_WRITE_TOOL,
  SECTION_WRITE_TOOL,
  SECTION_REVISE_TOOL,
  type WritingToolName
} from './writingTools'

const TOOL_NAMES: readonly string[] = [
  GROUNDING_SELECT_TOOL,
  OUTLINE_WRITE_TOOL,
  SECTION_WRITE_TOOL,
  SECTION_REVISE_TOOL
]

const isWritingToolName = (value: unknown): value is WritingToolName =>
  typeof value === 'string' && TOOL_NAMES.includes(value)

// Reads stored tool calls back, dropping anything it does not recognise
// rather than failing. A file may have been written by a newer build naming
// a tool this one has never heard of, or by a build whose record shape has
// moved on; the prose is in `response` and is what the reader actually needs,
// so a tool call it cannot make sense of is worth less than the script it
// would otherwise take down with it. Shared with the library importer so both
// entry points drop on exactly the same terms.
export const sanitizeGenerationToolCalls = (value: unknown): GenerationToolCall[] | undefined => {
  if (!Array.isArray(value)) return undefined

  const calls: GenerationToolCall[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    if (!isWritingToolName(record.name)) continue
    if (record.status !== 'accepted' && record.status !== 'rejected' && record.status !== 'waived') {
      continue
    }
    // Fields are rebuilt in the order they are declared on GenerationToolCall
    // so that a reparsed call serializes back to byte-identical YAML — a file
    // that changed every time it was opened would churn storage for nothing.
    calls.push({
      id: record.id,
      name: record.name,
      ...(typeof record.title === 'string' && record.title.length > 0
        ? { title: record.title }
        : {}),
      status: record.status,
      ...(typeof record.wordCount === 'number' && Number.isFinite(record.wordCount)
        ? { wordCount: record.wordCount }
        : {}),
      ...(typeof record.reason === 'string' && record.reason.length > 0
        ? { reason: record.reason }
        : {})
    })
  }

  // An empty list and no list at all mean the same thing to every reader, so
  // they are stored the same way — which also keeps serialize/parse stable.
  return calls.length > 0 ? calls : undefined
}

interface YamlBlock {
  type: 'conversation' | 'prompt' | 'response'
  timestamp?: number
  role?: 'user' | 'assistant' | 'system'
  id?: string
  scriptId?: string
  createdAt?: number
  updatedAt?: number
  cachedTokens?: number
  model?: string
  exampleIds?: string[]
  toolCalls?: unknown
}

export function parseConversationFromYamlMarkdown(content: string): RawConversation | null {
  if (!content) return null
  
  const blocks = content.split(/^---$/gm).filter(Boolean)
  
  let conversation: RawConversation | null = null
  const currentMessages: ChatMessage[] = []
  const generations: Generation[] = []
  let pendingPrompt: ChatMessage | null = null
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim()
    if (!block) continue
    
    try {
      const parsed = YAML.parse(block) as YamlBlock
      
      if (parsed.type === 'conversation') {
        conversation = {
          id: parsed.id || '',
          scriptId: parsed.scriptId || '',
          generations: [],
          createdAt: parsed.createdAt || Date.now(),
          updatedAt: parsed.updatedAt || Date.now()
        }
      } else if (parsed.type === 'prompt' && parsed.role === 'user') {
        const nextBlock = blocks[i + 1]?.trim()
        if (nextBlock && !nextBlock.startsWith('type:')) {
          pendingPrompt = {
            role: 'user',
            content: nextBlock
          }
          i++
        }
      } else if (parsed.type === 'response' && parsed.role === 'assistant') {
        const nextBlock = blocks[i + 1]?.trim()
        // The block after the header is the response body unless it is the
        // next header, in which case this generation simply has no prose
        const hasBody = Boolean(nextBlock) && !nextBlock!.startsWith('type:')
        const body = hasBody ? nextBlock! : ''
        const toolCalls = sanitizeGenerationToolCalls(parsed.toolCalls)

        // A generation earns its place if it produced prose or made a tool
        // call. Skipping a bodiless one would strand its prompt in
        // pendingPrompt and attach it to the next generation instead.
        if (body || toolCalls) {
          if (pendingPrompt) {
            currentMessages.push(pendingPrompt)
          }

          // Only a generation with prose contributes an assistant turn; an
          // empty assistant message would be a message the model never sent
          if (body) {
            const assistantMessage: ChatMessage = {
              role: 'assistant',
              content: body
            }

            currentMessages.push(assistantMessage)
          }

          generations.push({
            messages: [...currentMessages],
            response: body,
            timestamp: parsed.timestamp || Date.now(),
            cachedTokens: parsed.cachedTokens,
            exampleIds: Array.isArray(parsed.exampleIds)
              ? parsed.exampleIds.map(String)
              : undefined,
            toolCalls
          })

          pendingPrompt = null
        }

        if (hasBody) i++
      }
    } catch {
      continue
    }
  }
  
  if (conversation) {
    conversation.generations = generations
    return conversation
  }
  
  return null
}

export function serializeConversationToYamlMarkdown(conversation: RawConversation): string {
  const lines: string[] = []
  
  lines.push('---')
  lines.push(YAML.stringify({
    type: 'conversation',
    id: conversation.id,
    scriptId: conversation.scriptId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  }).trim())
  lines.push('---')
  lines.push('')
  
  for (const generation of conversation.generations) {
    const userMessage = generation.messages.find(m => m.role === 'user')
    const assistantMessage = generation.messages.find(m => m.role === 'assistant')
    // The generation's own response is authoritative; some generations (e.g.
    // the outline) carry no assistant message in their request messages
    const responseContent = generation.response || assistantMessage?.content || ''
    const toolCalls = generation.toolCalls
    
    if (userMessage) {
      lines.push('---')
      lines.push(YAML.stringify({
        type: 'prompt',
        timestamp: generation.timestamp,
        role: 'user'
      }).trim())
      lines.push('---')
      lines.push(userMessage.content)
      lines.push('')
    }
    
    // A generation that only made tool calls has no prose to write, but its
    // calls still have to be written — and without a response block its
    // prompt would be reparsed onto the following generation
    if (responseContent || (toolCalls && toolCalls.length > 0)) {
      lines.push('---')
      lines.push(YAML.stringify({
        type: 'response',
        timestamp: generation.timestamp,
        role: 'assistant',
        cachedTokens: generation.cachedTokens,
        ...(generation.exampleIds && generation.exampleIds.length > 0
          ? { exampleIds: generation.exampleIds }
          : {}),
        // Optional, like exampleIds: absent when there are none, so files
        // written here still parse under a build that predates the field
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {})
      }).trim())
      lines.push('---')
      lines.push(responseContent)
      lines.push('')
    }
  }
  
  return lines.join('\n')
}

export function migrateJsonToYamlMarkdown(jsonData: RawConversation[]): Map<string, string> {
  const conversationMap = new Map<string, string>()
  
  if (Array.isArray(jsonData)) {
    for (const conv of jsonData) {
      if (conv.scriptId) {
        const yamlMarkdown = serializeConversationToYamlMarkdown(conv)
        conversationMap.set(`conversation_${conv.scriptId}`, yamlMarkdown)
      }
    }
  }
  
  return conversationMap
}