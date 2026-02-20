import { createContext } from 'react'
import type { RawConversation, GenerationRequest, SectionRegenerationRequest } from '../types/conversation'
import type { RawConversationAction, RawConversationState } from '../reducers/rawConversationReducer'

export type ConversationContextType = {
  state: RawConversationState
  dispatch: (action: RawConversationAction) => void
  getConversationByScriptId: (scriptId: string) => RawConversation | undefined
  createConversation: (scriptId: string) => RawConversation
  generateScript: (request: GenerationRequest) => Promise<void>
  regenerateSection: (request: SectionRegenerationRequest) => Promise<void>
  stopGeneration: () => void
}

export const ConversationContext = createContext<ConversationContextType | undefined>(undefined)