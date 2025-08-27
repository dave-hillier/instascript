import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Conversation, GenerationRequest } from '../types/conversation'
import { ConversationContext } from './ConversationContext'
import type { ConversationContextType } from './ConversationContext'
import { useServices } from '../hooks/useServices'
import { useAppContext } from '../hooks/useAppContext'

// Extracted modules
import { conversationReducer } from '../reducers/conversationReducer'
import { getStoredConversations, setStoredConversations } from '../services/conversationStorage'
import { ScriptGenerationOrchestrator, type ScriptServices, type GenerationCallbacks } from '../services/scriptGenerationOrchestrator'

type ConversationProviderProps = {
  children: ReactNode
}

export const ConversationProvider = ({ children }: ConversationProviderProps) => {
  const [state, dispatch] = useReducer(conversationReducer, {
    conversations: [],
    currentGeneration: null
  })

  const [isLoaded, setIsLoaded] = useState(false)
  const { scriptService, exampleService } = useServices()
  const { dispatch: appDispatch } = useAppContext()
  const pendingConversationRef = useRef<Conversation | null>(null)


  // Direct script generation without job processing
  const generateScript = useCallback(async (request: GenerationRequest, abortSignal?: AbortSignal): Promise<void> => {
    // Find conversation - first check pending, then state
    let conversation: Conversation | undefined
    
    if (request.conversationId && pendingConversationRef.current?.id === request.conversationId) {
      conversation = pendingConversationRef.current
      pendingConversationRef.current = null
    } else if (request.conversationId) {
      conversation = state.conversations.find(c => c.id === request.conversationId)
    }

    const services: ScriptServices = {
      scriptService,
      exampleService
    }

    const callbacks: GenerationCallbacks = {
      dispatch,
      appDispatch,
      onRegenerationCheck: () => {
        // No auto-regeneration for now - keep it simple
      }
    }

    const orchestrator = new ScriptGenerationOrchestrator(services, callbacks)
    await orchestrator.generateScript(request, conversation, abortSignal)
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


  const getConversationByScriptId = useCallback((scriptId: string): Conversation | undefined => {
    return state.conversations.find(conv => conv.scriptId === scriptId)
  }, [state.conversations])

  const createConversation = useCallback((scriptId: string, initialPrompt: string): Conversation => {
    const conversation: Conversation = {
      id: `conv_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      scriptId,
      messages: [{
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        role: 'user',
        content: initialPrompt,
        timestamp: Date.now()
      }],
      sections: [],
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    
    pendingConversationRef.current = conversation
    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    return conversation
  }, [])

  const contextValue: ConversationContextType = {
    state,
    dispatch,
    getConversationByScriptId,
    createConversation,
    generateScript
  }

  return (
    <ConversationContext.Provider value={contextValue}>
      {children}
    </ConversationContext.Provider>
  )
}