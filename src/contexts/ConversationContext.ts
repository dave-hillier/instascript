import { createContext } from 'react'
import type { RawConversation, GenerationRequest } from '../types/conversation'
import type { RawConversationAction, RawConversationState } from '../reducers/rawConversationReducer'

export type ConversationContextType = {
  state: RawConversationState
  dispatch: (action: RawConversationAction) => void
  getConversationByScriptId: (scriptId: string) => RawConversation | undefined
  createConversation: (scriptId: string, initialPrompt: string) => RawConversation
  generateScript: (request: GenerationRequest) => Promise<void>
}

export const ConversationContext = createContext<ConversationContextType | undefined>(undefined)