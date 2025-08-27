import type { Conversation, Message, ConversationSection, GenerationProgress } from '../types/conversation'
import type { ExampleScript } from '../services/vectorStore'

export type ConversationAction = 
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
  | { type: 'STORE_EXAMPLES'; conversationId: string; examples: ExampleScript[] }

export type ConversationState = {
  conversations: Conversation[]
  currentGeneration: GenerationProgress | null
}

export const conversationReducer = (state: ConversationState, action: ConversationAction): ConversationState => {
  switch (action.type) {
    case 'LOAD_CONVERSATIONS':
      return { ...state, conversations: action.conversations }
    
    case 'CREATE_CONVERSATION':
      return { 
        ...state, 
        conversations: [...state.conversations, action.conversation] 
      }
    
    case 'ADD_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { 
                ...conv, 
                messages: [...conv.messages, action.message],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'UPDATE_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? {
                ...conv,
                messages: conv.messages.map(msg =>
                  msg.id === action.messageId
                    ? { ...msg, content: action.content }
                    : msg
                ),
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'SET_CONVERSATION_STATUS':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, status: action.status, updatedAt: Date.now() }
            : conv
        )
      }
    
    case 'SET_CONVERSATION_TITLE':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, title: action.title, updatedAt: Date.now() }
            : conv
        )
      }
    
    case 'CREATE_SECTION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { 
                ...conv, 
                sections: [...conv.sections, action.section],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'UPDATE_SECTION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? {
                ...conv,
                sections: conv.sections.map(section =>
                  section.id === action.sectionId
                    ? { ...section, ...action.updates }
                    : section
                ),
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'SET_GENERATION_PROGRESS':
      return { ...state, currentGeneration: action.progress }
    
    case 'DELETE_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.filter(conv => conv.id !== action.conversationId)
      }
    
    case 'STORE_EXAMPLES':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, examples: action.examples }
            : conv
        )
      }
    
    default:
      return state
  }
}