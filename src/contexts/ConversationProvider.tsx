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
import { isReviewPassEnabled, getModel } from '../services/config'
import { findRunScript, type PendingRunPin } from '../services/serviceFactory'
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
  const { state: appState, dispatch: appDispatch } = useAppContext()
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
  // Same reason as conversationsRef: a run reads the script it is writing to
  // find the model pinned on it, and that lookup happens inside callbacks that
  // outlive the render they were built in
  const scriptsRef = useRef(appState.scripts)
  scriptsRef.current = appState.scripts
  // The model pin for a script whose record has not reached this provider yet.
  // A run can be started in the same event that creates its script — the page
  // dispatches ADD_SCRIPT and then awaits the run without returning to React —
  // so no render has happened, scriptsRef still holds the state from before the
  // script existed, and the lookup above would miss it. Assigning the ref
  // during render cannot help: there is no render to assign in. What is
  // available is this: the caller creates the conversation in that same event,
  // one step after stamping the new script with getModel(), so the setting read
  // here is the model that went onto the script.
  const pendingRunPinRef = useRef<PendingRunPin | null>(null)

  const stopGeneration = useCallback(() => {
    runLifecycleRef.current.stop()
  }, [])

  const buildCallbacks = useCallback((): RawGenerationCallbacks => ({
    dispatch,
    appDispatch,
    saveConversation: saveStoredConversation,
    getConversation: (conversationId: string) =>
      conversationsRef.current.find(c => c.id === conversationId),
    // The run's model pin: the orchestrator asks for the script a conversation
    // belongs to so the mode decision is made from the model that script was
    // started on rather than from whatever the setting says at this moment.
    // A script too new to be in state is answered from the pin captured when
    // its conversation was created, which is that same model.
    getScript: (scriptId: string) =>
      findRunScript(scriptId, scriptsRef.current, pendingRunPinRef.current)
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
    // Captured now, while the creating event is still running, so a run that
    // starts before the script record is rendered still plans from the model
    // that script was pinned to rather than from the setting as it stands
    // several awaits later. A script already in scriptsRef outranks this.
    pendingRunPinRef.current = { scriptId, model: getModel() }
    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    return conversation
  }, [])

  // Duplicates the source script's conversation (story 4.3): the copy gets
  // its own id and deep-copied generations, and is saved immediately since
  // no generation run will save it.
  //
  // The copy carries the model's findings, because they are part of the
  // conversation and describe how these very bodies were written. It carries
  // none of the reader's marks, because those live in localStorage keyed by
  // script id and the copy has a new one (M3). That is the behaviour we want
  // rather than an accident of where they are stored: a mark is about a body,
  // and the duplicate exists precisely so its bodies can diverge from the ones
  // the marks were pinned to.
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