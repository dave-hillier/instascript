import { createContext } from 'react'
import type { RawConversation, Generation, GenerationRequest, SectionRegenerationRequest, ScriptRefinementRequest, SectionEditRequest } from '../types/conversation'
import type { RawConversationAction, RawConversationState } from '../reducers/rawConversationReducer'

export type ConversationContextType = {
  state: RawConversationState
  // False until the initial async load from persistent storage completes
  isLoaded: boolean
  dispatch: (action: RawConversationAction) => void
  getConversationByScriptId: (scriptId: string) => RawConversation | undefined
  createConversation: (scriptId: string) => RawConversation
  duplicateConversation: (sourceScriptId: string, newScriptId: string) => RawConversation
  // Creates a conversation that is already written — a corpus example opened
  // as a script (story 8.16) arrives as its outline and sections rather than
  // being generated
  adoptConversation: (scriptId: string, generations: Generation[]) => RawConversation
  generateScript: (request: GenerationRequest) => Promise<void>
  regenerateSection: (request: SectionRegenerationRequest) => Promise<void>
  refineScript: (request: ScriptRefinementRequest) => Promise<void>
  // Reviews the finished script for cohesion and length against its brief
  // and the spoken length it was asked for
  reviewScript: (conversationId: string, brief: string, targetMinutes?: number) => Promise<void>
  editSection: (request: SectionEditRequest) => void
  stopGeneration: () => void
}

export const ConversationContext = createContext<ConversationContextType | undefined>(undefined)
