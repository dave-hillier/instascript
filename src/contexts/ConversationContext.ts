import { createContext } from 'react'
import type { Conversation, Message, ConversationSection, GenerationRequest, GenerationProgress } from '../types/conversation'

type ConversationAction = 
  | { type: 'LOAD_CONVERSATIONS'; conversations: Conversation[] }
  | { type: 'CREATE_CONVERSATION'; conversation: Conversation }
  | { type: 'ADD_MESSAGE'; conversationId: string; message: Message }
  | { type: 'UPDATE_MESSAGE'; conversationId: string; messageId: string; content: string }
  | { type: 'SET_CONVERSATION_STATUS'; conversationId: string; status: Conversation['status'] }
  | { type: 'SET_CONVERSATION_TITLE'; conversationId: string; title: string }
  | { type: 'CREATE_SECTION'; conversationId: string; section: ConversationSection }
  | { type: 'UPDATE_SECTION'; conversationId: string; sectionId: string; updates: Partial<ConversationSection> }
  | { type: 'SET_GENERATION_PROGRESS'; progress: GenerationProgress }
  | { type: 'DELETE_CONVERSATION'; conversationId: string }
  | { type: 'STORE_EXAMPLES'; conversationId: string; examples: any[] }

type ConversationState = {
  conversations: Conversation[]
  currentGeneration: GenerationProgress | null
}

export type ConversationContextType = {
  state: ConversationState
  dispatch: (action: ConversationAction) => void
  getConversationByScriptId: (scriptId: string) => Conversation | undefined
  createConversation: (scriptId: string, initialPrompt: string) => Conversation
  generateScript: (request: GenerationRequest) => Promise<void>
}

export const ConversationContext = createContext<ConversationContextType | undefined>(undefined)