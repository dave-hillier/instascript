import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RawConversation, GenerationRequest, RegenerationRequest, SectionRegenerationRequest } from '../types/conversation'
import { ConversationContext } from './ConversationContext'
import type { ConversationContextType } from './ConversationContext'
import { useServices } from '../hooks/useServices'
import { useAppContext } from '../hooks/useAppContext'

// Extracted modules
import { rawConversationReducer } from '../reducers/rawConversationReducer'
import { getStoredConversations, setStoredConversation, createRawConversation } from '../services/conversationStorage'
import { RawScriptGenerationOrchestrator, type RawScriptServices, type RawGenerationCallbacks } from '../services/rawScriptGenerationOrchestrator'
import { getSectionRegenerationPrompt } from '../services/prompts'

type ConversationProviderProps = {
  children: ReactNode
}

export const ConversationProvider = ({ children }: ConversationProviderProps) => {
  const [state, dispatch] = useReducer(rawConversationReducer, {
    conversations: [],
    currentGeneration: null,
    generationMachine: null
  })

  const [, setIsLoaded] = useState(false)
  const { scriptService, exampleService } = useServices()
  const { dispatch: appDispatch } = useAppContext()
  const pendingConversationRef = useRef<RawConversation | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  // Ref that always points to the latest conversations state, avoiding stale closures
  // in long-running async callbacks (streaming can take seconds)
  const conversationsRef = useRef(state.conversations)
  conversationsRef.current = state.conversations

  const stopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const buildCallbacks = useCallback((): RawGenerationCallbacks => ({
    dispatch,
    appDispatch,
    saveConversation: setStoredConversation,
    getConversation: (conversationId: string) =>
      conversationsRef.current.find(c => c.id === conversationId)
  }), [dispatch, appDispatch])

  // Direct script generation without job processing
  const generateScript = useCallback(async (request: GenerationRequest): Promise<void> => {
    // Abort any existing generation
    stopGeneration()
    const controller = new AbortController()
    abortControllerRef.current = controller

    // Find conversation - first check pending, then current state
    let conversation: RawConversation | undefined

    if (request.conversationId && pendingConversationRef.current?.id === request.conversationId) {
      conversation = pendingConversationRef.current
      pendingConversationRef.current = null
    } else if (request.conversationId) {
      conversation = conversationsRef.current.find(c => c.id === request.conversationId)
    }

    const services: RawScriptServices = {
      scriptService,
      exampleService
    }

    try {
      const orchestrator = new RawScriptGenerationOrchestrator(services, buildCallbacks())
      await orchestrator.generateScript(request, conversation, controller.signal)
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }, [scriptService, exampleService, stopGeneration, buildCallbacks])

  const regenerateSection = useCallback(async (request: SectionRegenerationRequest): Promise<void> => {
    // Abort any existing generation
    stopGeneration()
    const controller = new AbortController()
    abortControllerRef.current = controller

    // Find conversation in current state
    const conversation = conversationsRef.current.find(c => c.id === request.conversationId)
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

    try {
      const orchestrator = new RawScriptGenerationOrchestrator(services, buildCallbacks())
      await orchestrator.regenerateSection(regenerationRequest, conversation, controller.signal)
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }, [scriptService, exampleService, stopGeneration, buildCallbacks])


  // Initial load from localStorage
  useEffect(() => {
    const stored = getStoredConversations()
    if (stored.length > 0) {
      dispatch({ type: 'LOAD_CONVERSATIONS', conversations: stored })
    }
    setIsLoaded(true)
  }, [])

  // Note: Conversations are now saved directly by the orchestrator after API interactions
  // No UI-triggered saves to avoid performance issues


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
    regenerateSection,
    stopGeneration
  }

  return (
    <ConversationContext.Provider value={contextValue}>
      {children}
    </ConversationContext.Provider>
  )
}