import { createContext } from 'react'
import type { RawConversation, GenerationRequest, RegenerationRequest } from '../types/conversation'
import type { RawConversationAction, RawConversationState } from '../reducers/rawConversationReducer'

export type ConversationContextType = {
  state: RawConversationState
  dispatch: (action: RawConversationAction) => void
  getConversationByScriptId: (scriptId: string) => RawConversation | undefined
  createConversation: (scriptId: string) => RawConversation
  generateScript: (request: GenerationRequest) => Promise<void>
  regenerateSection: (request: RegenerationRequest) => Promise<void>
}

export const ConversationContext = createContext<ConversationContextType | undefined>(undefined)