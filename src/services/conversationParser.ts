import YAML from 'yaml'
import type { RawConversation, Generation, ChatMessage } from '../types/conversation'

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
        if (nextBlock && !nextBlock.startsWith('type:')) {
          if (pendingPrompt) {
            currentMessages.push(pendingPrompt)
          }
          
          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: nextBlock
          }
          
          currentMessages.push(assistantMessage)
          
          generations.push({
            messages: [...currentMessages],
            response: nextBlock,
            timestamp: parsed.timestamp || Date.now(),
            cachedTokens: parsed.cachedTokens
          })
          
          pendingPrompt = null
          i++
        }
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
    
    if (assistantMessage) {
      lines.push('---')
      lines.push(YAML.stringify({
        type: 'response',
        timestamp: generation.timestamp,
        role: 'assistant',
        cachedTokens: generation.cachedTokens
      }).trim())
      lines.push('---')
      lines.push(assistantMessage.content)
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