

export interface GenerationRequest {
  prompt: string
  conversationId?: string
}

export interface RegenerationRequest {
  prompt: string
  conversationId: string
  sectionTitle: string
}

export interface SectionRegenerationRequest {
  conversationId: string
  sectionTitle: string
}

export interface GenerationProgress {
  conversationId: string
  sectionTitle?: string
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