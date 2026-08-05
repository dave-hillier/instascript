import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RawConversation, Generation, GenerationRequest, RegenerationRequest, SectionRegenerationRequest, ScriptRefinementRequest, SectionEditRequest } from '../types/conversation'
import { ConversationContext } from './ConversationContext'
import type { ConversationContextType } from './ConversationContext'
import { useServices } from '../hooks/useServices'
import { useAppContext } from '../hooks/useAppContext'

// Extracted modules
import { rawConversationReducer } from '../reducers/rawConversationReducer'
import { loadStoredConversations, saveStoredConversation, createRawConversation, duplicateRawConversation } from '../services/conversationStorage'
import { ensureSectionHeading } from '../services/conversationDocument'
import { RawScriptGenerationOrchestrator, type RawScriptServices, type RawGenerationCallbacks } from '../services/rawScriptGenerationOrchestrator'
import { buildSectionRegenerationPromptFromConversation, getScriptRefinementPrompt } from '../services/prompts'
import { isReviewPassEnabled } from '../services/config'
import { RunLifecycle } from '../services/runLifecycle'

type ConversationProviderProps = {
  children: ReactNode
}

export const ConversationProvider = ({ children }: ConversationProviderProps) => {
  const [state, dispatch] = useReducer(rawConversationReducer, {
    conversations: [],
    currentGeneration: null,
    generationMachine: null,
    reviewReport: null
  })

  const [isLoaded, setIsLoaded] = useState(false)
  const { scriptService, exampleService } = useServices()
  const { dispatch: appDispatch } = useAppContext()
  const pendingConversationRef = useRef<RawConversation | null>(null)
  // The single-active-run invariant lives in RunLifecycle (services/runLifecycle):
  // starting a new run first aborts and awaits the previous one so its
  // asynchronous abort-cleanup dispatches settle before the new run claims the
  // singleton currentGeneration/generationMachine state
  const runLifecycleRef = useRef(new RunLifecycle())
  // Ref that always points to the latest conversations state, avoiding stale closures
  // in long-running async callbacks (streaming can take seconds)
  const conversationsRef = useRef(state.conversations)
  conversationsRef.current = state.conversations

  const stopGeneration = useCallback(() => {
    runLifecycleRef.current.stop()
  }, [])

  const buildCallbacks = useCallback((): RawGenerationCallbacks => ({
    dispatch,
    appDispatch,
    saveConversation: saveStoredConversation,
    getConversation: (conversationId: string) =>
      conversationsRef.current.find(c => c.id === conversationId)
  }), [dispatch, appDispatch])

  // Direct script generation without job processing
  const generateScript = useCallback(async (request: GenerationRequest): Promise<void> => {
    // Abort any existing generation and wait for it to settle first
    const controller = await runLifecycleRef.current.admit()

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

    const orchestrator = new RawScriptGenerationOrchestrator(
      services,
      buildCallbacks(),
      { reviewPassEnabled: isReviewPassEnabled() }
    )
    await runLifecycleRef.current.track(
      controller,
      orchestrator.generateScript(request, conversation, controller.signal)
    )
  }, [scriptService, exampleService, buildCallbacks])

  const regenerateSection = useCallback(async (request: SectionRegenerationRequest): Promise<void> => {
    // Abort any existing generation and wait for it to settle first
    const controller = await runLifecycleRef.current.admit()

    // Find conversation in current state
    const conversation = conversationsRef.current.find(c => c.id === request.conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} not found`)
    }

    // Build the prompt from the section's outline entry, the current
    // surrounding sections, and any custom instruction from the user
    const prompt = buildSectionRegenerationPromptFromConversation(
      conversation,
      request.sectionTitle,
      request.instruction
    )

    const regenerationRequest: RegenerationRequest = {
      prompt,
      conversationId: request.conversationId,
      sectionTitle: request.sectionTitle,
      targetMinutes: request.targetMinutes,
      brief: request.brief
    }

    const services: RawScriptServices = {
      scriptService,
      exampleService
    }

    const orchestrator = new RawScriptGenerationOrchestrator(services, buildCallbacks())
    await runLifecycleRef.current.track(
      controller,
      orchestrator.regenerateSection(regenerationRequest, conversation, controller.signal)
    )
  }, [scriptService, exampleService, buildCallbacks])

  const refineScript = useCallback(async (request: ScriptRefinementRequest): Promise<void> => {
    // Abort any existing generation and wait for it to settle first
    const controller = await runLifecycleRef.current.admit()

    // Find conversation in current state
    const conversation = conversationsRef.current.find(c => c.id === request.conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} not found`)
    }

    const prompt = getScriptRefinementPrompt(request.instruction)

    const services: RawScriptServices = {
      scriptService,
      exampleService
    }

    const orchestrator = new RawScriptGenerationOrchestrator(services, buildCallbacks())
    await runLifecycleRef.current.track(
      controller,
      orchestrator.refineScript(
        {
          prompt,
          conversationId: request.conversationId,
          targetMinutes: request.targetMinutes,
          brief: request.brief
        },
        conversation,
        controller.signal
      )
    )
  }, [scriptService, exampleService, buildCallbacks])


  // Runs the whole-script review on demand against the script as it currently
  // stands (story 8.14), independent of the automatic style-pass setting
  const reviewScript = useCallback(async (
    conversationId: string,
    brief: string,
    targetMinutes?: number
  ): Promise<void> => {
    // Abort any existing generation and wait for it to settle first
    const controller = await runLifecycleRef.current.admit()

    const conversation = conversationsRef.current.find(c => c.id === conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`)
    }

    const services: RawScriptServices = {
      scriptService,
      exampleService
    }

    const orchestrator = new RawScriptGenerationOrchestrator(services, buildCallbacks())
    await runLifecycleRef.current.track(
      controller,
      orchestrator.reviewScript(conversation, brief, targetMinutes, controller.signal)
    )
  }, [scriptService, exampleService, buildCallbacks])

  // Persists a manual section edit as a completed generation of its own
  // (story 2.3): the response carries the "## Title" heading so
  // consolidation-by-title replaces the section, and later regenerations see
  // the edited text both in conversation history and in their prompts
  const editSection = useCallback((request: SectionEditRequest): void => {
    // Appending a generation while one is streaming would let the stream
    // overwrite the edit (streaming always updates the latest generation)
    if (runLifecycleRef.current.isRunning) {
      throw new Error('Cannot edit a section while a generation is in progress')
    }

    const conversation = conversationsRef.current.find(c => c.id === request.conversationId)
    if (!conversation) {
      throw new Error(`Conversation ${request.conversationId} not found`)
    }

    const generation: Generation = {
      messages: [{
        role: 'user',
        content: `I have manually edited the "${request.sectionTitle}" section. The version below replaces the previous one.`
      }],
      response: ensureSectionHeading(request.sectionTitle, request.content.trim()),
      timestamp: Date.now()
    }

    dispatch({ type: 'SECTION_EDITED', conversationId: conversation.id, generation })
    saveStoredConversation({
      ...conversation,
      generations: [...conversation.generations, generation],
      updatedAt: Date.now()
    })
  }, [])

  // Initial load from persistent storage (OPFS, or localStorage fallback).
  // Loading is async, so anything created in the meantime is preserved by
  // the reducer merging loaded conversations underneath existing ones.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const stored = await loadStoredConversations()
      if (cancelled) return
      if (stored.length > 0) {
        dispatch({ type: 'LOAD_CONVERSATIONS', conversations: stored })
      }
      setIsLoaded(true)
    }
    void load()
    return () => {
      cancelled = true
    }
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

  // Duplicates the source script's conversation (story 4.3): the copy gets
  // its own id and deep-copied generations, and is saved immediately since
  // no generation run will save it
  const duplicateConversation = useCallback((sourceScriptId: string, newScriptId: string): RawConversation => {
    const source = conversationsRef.current.find(conv => conv.scriptId === sourceScriptId)
    const conversation = duplicateRawConversation(source, newScriptId)

    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    saveStoredConversation(conversation)
    return conversation
  }, [])

  // A conversation that arrives already written: an example opened as a
  // script (story 8.16) reconstructs the outline and section generations, so
  // like a duplicate it is saved here rather than by a generation run
  const adoptConversation = useCallback((
    scriptId: string,
    generations: Generation[]
  ): RawConversation => {
    const conversation = { ...createRawConversation(scriptId), generations }

    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    saveStoredConversation(conversation)
    return conversation
  }, [])

  const contextValue: ConversationContextType = {
    state,
    isLoaded,
    dispatch,
    getConversationByScriptId,
    createConversation,
    duplicateConversation,
    adoptConversation,
    generateScript,
    regenerateSection,
    refineScript,
    reviewScript,
    editSection,
    stopGeneration
  }

  return (
    <ConversationContext.Provider value={contextValue}>
      {children}
    </ConversationContext.Provider>
  )
}