import type { RawConversation, ChatMessage } from '../types/conversation'

export type RawConversationAction = 
  | { type: 'LOAD_CONVERSATIONS'; conversations: RawConversation[] }
  | { type: 'CREATE_CONVERSATION'; conversation: RawConversation }
  | { type: 'START_GENERATION'; conversationId: string; messages: ChatMessage[] }
  | { type: 'UPDATE_CURRENT_GENERATION'; conversationId: string; response: string; cachedTokens?: number }
  | { type: 'COMPLETE_GENERATION'; conversationId: string; response: string; cachedTokens?: number }
  | { type: 'DELETE_CONVERSATION'; conversationId: string }
  | { type: 'SET_GENERATION_PROGRESS'; conversationId: string; isComplete: boolean; error?: string; sectionTitle?: string }

export type RawConversationState = {
  conversations: RawConversation[]
  currentGeneration: {
    conversationId: string
    isComplete: boolean
    error?: string
    sectionTitle?: string
  } | null
}

export const rawConversationReducer = (
  state: RawConversationState, 
  action: RawConversationAction
): RawConversationState => {
  switch (action.type) {
    case 'LOAD_CONVERSATIONS':
      return { ...state, conversations: action.conversations }
    
    case 'CREATE_CONVERSATION':
      return { 
        ...state, 
        conversations: [...state.conversations, action.conversation] 
      }
    
    case 'START_GENERATION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { 
                ...conv,
                generations: [...conv.generations, {
                  messages: action.messages,
                  response: '',
                  timestamp: Date.now()
                }],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'UPDATE_CURRENT_GENERATION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId && conv.generations.length > 0
            ? {
                ...conv,
                generations: [
                  ...conv.generations.slice(0, -1),
                  {
                    ...conv.generations[conv.generations.length - 1],
                    response: action.response,
                    cachedTokens: action.cachedTokens
                  }
                ],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    
    case 'COMPLETE_GENERATION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId && conv.generations.length > 0
            ? {
                ...conv,
                generations: [
                  ...conv.generations.slice(0, -1),
                  {
                    ...conv.generations[conv.generations.length - 1],
                    response: action.response,
                    cachedTokens: action.cachedTokens
                  }
                ],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'DELETE_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.filter(conv => conv.id !== action.conversationId)
      }
    
    case 'SET_GENERATION_PROGRESS':
      // Prevent reverting completion state - once complete, stay complete
      if (state.currentGeneration?.conversationId === action.conversationId && 
          state.currentGeneration?.isComplete && 
          !action.isComplete) {
        return state
      }
      
      return { 
        ...state, 
        currentGeneration: {
          conversationId: action.conversationId,
          isComplete: action.isComplete,
          error: action.error,
          sectionTitle: action.sectionTitle
        }
      }
    
    default:
      return state
  }
}