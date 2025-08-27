import type { ExampleScript } from '../services/vectorStore'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface Message {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  sectionId?: string
}

export interface ConversationSection {
  id: string
  title: string
  content: string
  status: 'pending' | 'generating' | 'completed' | 'error'
  messageIds: string[]
  wasRegenerated?: boolean
}

export interface Conversation {
  id: string
  scriptId: string
  title?: string
  messages: Message[]
  sections: ConversationSection[]
  examples?: ExampleScript[]
  status: 'idle' | 'generating' | 'completed' | 'error'
  createdAt: number
  updatedAt: number
}

export interface GenerationRequest {
  prompt: string
  conversationId?: string
  sectionId?: string
  regenerate?: boolean
  sectionTitle?: string
}

export interface GenerationProgress {
  conversationId: string
  sectionId?: string
  content: string
  isComplete: boolean
  error?: string
}

// New simplified types for raw response storage
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Generation {
  messages: ChatMessage[] // Complete messages array sent to OpenAI
  response: string // Assistant response received
  timestamp: number
  cachedTokens?: number // From OpenAI response for monitoring cache hits
}

export interface RawConversation {
  id: string
  scriptId: string
  generations: Generation[] // All generations with complete prompt context
  createdAt: number
  updatedAt: number
}

export interface ParsedDocumentHeader {
  title?: string
  detected: boolean
}

export interface ParsedSection {
  title: string
  content: string
  wordCount: number
  startLine: number
  endLine: number
}

export interface ConversationDocument {
  header: ParsedDocumentHeader
  sections: ParsedSection[]
  fullContent: string
  totalWordCount: number
}