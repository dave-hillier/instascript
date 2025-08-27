import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RawConversation, GenerationRequest, RegenerationRequest, SectionRegenerationRequest } from '../types/conversation'
import { ConversationContext } from './ConversationContext'
import type { ConversationContextType } from './ConversationContext'
import { useServices } from '../hooks/useServices'
import { useAppContext } from '../hooks/useAppContext'

// Extracted modules
import { rawConversationReducer } from '../reducers/rawConversationReducer'
import { getStoredConversations, setStoredConversations, createRawConversation } from '../services/conversationStorage'
import { RawScriptGenerationOrchestrator, type RawScriptServices, type RawGenerationCallbacks } from '../services/rawScriptGenerationOrchestrator'
import { getSectionRegenerationPrompt } from '../services/prompts'

type ConversationProviderProps = {
  children: ReactNode
}

export const ConversationProvider = ({ children }: ConversationProviderProps) => {
  const [state, dispatch] = useReducer(rawConversationReducer, {
    conversations: [],
    currentGeneration: null
  })

  const [isLoaded, setIsLoaded] = useState(false)
  const { scriptService, exampleService } = useServices()
  const { dispatch: appDispatch } = useAppContext()
  const pendingConversationRef = useRef<RawConversation | null>(null)
  // Direct script generation without job processing
  const generateScript = useCallback(async (request: GenerationRequest, abortSignal?: AbortSignal): Promise<void> => {
    // Find conversation - first check pending, then current state
    let conversation: RawConversation | undefined
    
    if (request.conversationId && pendingConversationRef.current?.id === request.conversationId) {
      conversation = pendingConversationRef.current
      pendingConversationRef.current = null
    } else if (request.conversationId) {
      conversation = state.conversations.find(c => c.id === request.conversationId)
    }

    const services: RawScriptServices = {
      scriptService,
      exampleService
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch,
      appDispatch
    }

    const orchestrator = new RawScriptGenerationOrchestrator(services, callbacks)
    await orchestrator.generateScript(request, conversation, abortSignal)
  }, [state.conversations, scriptService, exampleService, dispatch, appDispatch])

  const regenerateSection = useCallback(async (request: SectionRegenerationRequest, abortSignal?: AbortSignal): Promise<void> => {
    // Find conversation in current state
    const conversation = state.conversations.find(c => c.id === request.conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} not found`)
    }

    // Generate the prompt internally - encapsulate the prompt logic
    const prompt = getSectionRegenerationPrompt(request.sectionTitle)
    
    const regenerationRequest: RegenerationRequest = {
      prompt,
      conversationId: request.conversationId,
      sectionTitle: request.sectionTitle
    }

    const services: RawScriptServices = {
      scriptService,
      exampleService
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch,
      appDispatch
    }

    const orchestrator = new RawScriptGenerationOrchestrator(services, callbacks)
    await orchestrator.regenerateSection(regenerationRequest, conversation, abortSignal)
  }, [state.conversations, scriptService, exampleService, dispatch, appDispatch])


  // Initial load from localStorage
  useEffect(() => {
    const stored = getStoredConversations()
    if (stored.length > 0) {
      dispatch({ type: 'LOAD_CONVERSATIONS', conversations: stored })
    }
    setIsLoaded(true)
  }, [])

  // Save conversations to localStorage when state changes
  useEffect(() => {
    if (isLoaded && state.conversations.length > 0) {
      setStoredConversations(state.conversations)
    }
  }, [state.conversations, isLoaded])


  const getConversationByScriptId = useCallback((scriptId: string): RawConversation | undefined => {
    return state.conversations.find(conv => conv.scriptId === scriptId)
  }, [state.conversations])

  const createConversation = useCallback((scriptId: string): RawConversation => {
    const conversation = createRawConversation(scriptId)
    
    pendingConversationRef.current = conversation
    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    return conversation
  }, [])

  const contextValue: ConversationContextType = {
    state,
    dispatch,
    getConversationByScriptId,
    createConversation,
    generateScript,
    regenerateSection
  }

  return (
    <ConversationContext.Provider value={contextValue}>
      {children}
    </ConversationContext.Provider>
  )
}