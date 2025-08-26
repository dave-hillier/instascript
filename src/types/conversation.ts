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
}

export interface Conversation {
  id: string
  scriptId: string
  messages: Message[]
  sections: ConversationSection[]
  status: 'idle' | 'generating' | 'completed' | 'error'
  createdAt: number
  updatedAt: number
}

export interface GenerationRequest {
  prompt: string
  conversationId?: string
  sectionId?: string
  regenerate?: boolean
}

export interface GenerationProgress {
  conversationId: string
  sectionId?: string
  content: string
  isComplete: boolean
  error?: string
}