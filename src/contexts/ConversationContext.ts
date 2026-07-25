import { createContext } from 'react'
import type { RawConversation, GenerationRequest, SectionRegenerationRequest, ScriptRefinementRequest } from '../types/conversation'
import type { RawConversationAction, RawConversationState } from '../reducers/rawConversationReducer'

export type ConversationContextType = {
  state: RawConversationState
  // False until the initial async load from persistent storage completes
  isLoaded: boolean
  dispatch: (action: RawConversationAction) => void
  getConversationByScriptId: (scriptId: string) => RawConversation | undefined
  createConversation: (scriptId: string) => RawConversation
  duplicateConversation: (sourceScriptId: string, newScriptId: string) => RawConversation
  generateScript: (request: GenerationRequest) => Promise<void>
  regenerateSection: (request: SectionRegenerationRequest) => Promise<void>
  refineScript: (request: ScriptRefinementRequest) => Promise<void>
  stopGeneration: () => void
}

export const ConversationContext = createContext<ConversationContextType | undefined>(undefined)
