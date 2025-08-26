import { useReducer, useEffect, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Conversation, Message, ConversationSection, GenerationRequest, GenerationProgress } from '../types/conversation'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { ConversationContext } from './ConversationContext'
import type { ConversationContextType } from './ConversationContext'
import { APIService } from '../services/apiService'
import { ExampleService } from '../services/exampleService'
import type { APIProvider } from '../services/apiService'
import type { ExampleScript } from '../services/vectorStore'
import { Logger } from '../utils/logger'

type ConversationAction = 
  | { type: 'LOAD_CONVERSATIONS'; conversations: Conversation[] }
  | { type: 'CREATE_CONVERSATION'; conversation: Conversation }
  | { type: 'ADD_MESSAGE'; conversationId: string; message: Message }
  | { type: 'UPDATE_MESSAGE'; conversationId: string; messageId: string; content: string }
  | { type: 'SET_CONVERSATION_STATUS'; conversationId: string; status: Conversation['status'] }
  | { type: 'SET_CONVERSATION_TITLE'; conversationId: string; title: string }
  | { type: 'CREATE_SECTION'; conversationId: string; section: ConversationSection }
  | { type: 'UPDATE_SECTION'; conversationId: string; sectionId: string; updates: Partial<ConversationSection> }
  | { type: 'SET_GENERATION_PROGRESS'; progress: GenerationProgress }
  | { type: 'DELETE_CONVERSATION'; conversationId: string }

type ConversationState = {
  conversations: Conversation[]
  currentGeneration: GenerationProgress | null
}

const conversationReducer = (state: ConversationState, action: ConversationAction): ConversationState => {
  switch (action.type) {
    case 'LOAD_CONVERSATIONS':
      return { ...state, conversations: action.conversations }
    
    case 'CREATE_CONVERSATION':
      return { 
        ...state, 
        conversations: [...state.conversations, action.conversation] 
      }
    
    case 'ADD_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { 
                ...conv, 
                messages: [...conv.messages, action.message],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'UPDATE_MESSAGE':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? {
                ...conv,
                messages: conv.messages.map(msg =>
                  msg.id === action.messageId
                    ? { ...msg, content: action.content }
                    : msg
                ),
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'SET_CONVERSATION_STATUS':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, status: action.status, updatedAt: Date.now() }
            : conv
        )
      }
    
    case 'SET_CONVERSATION_TITLE':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, title: action.title, updatedAt: Date.now() }
            : conv
        )
      }
    
    case 'CREATE_SECTION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { 
                ...conv, 
                sections: [...conv.sections, action.section],
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'UPDATE_SECTION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? {
                ...conv,
                sections: conv.sections.map(section =>
                  section.id === action.sectionId
                    ? { ...section, ...action.updates }
                    : section
                ),
                updatedAt: Date.now()
              }
            : conv
        )
      }
    
    case 'SET_GENERATION_PROGRESS':
      return { ...state, currentGeneration: action.progress }
    
    case 'DELETE_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.filter(conv => conv.id !== action.conversationId)
      }
    
    default:
      return state
  }
}

type ConversationProviderProps = {
  children: ReactNode
}

export const ConversationProvider = ({ children }: ConversationProviderProps) => {
  const [state, dispatch] = useReducer(conversationReducer, {
    conversations: [],
    currentGeneration: null
  })

  const { value: storedConversations, setValue: setStoredConversations, isLoaded } = useLocalStorage<Conversation[]>('conversations', [])
  const { value: apiKey } = useLocalStorage<string>('apiKey', '')
  const { value: apiProvider } = useLocalStorage<APIProvider>('apiProvider', 'mock')
  const apiServiceRef = useRef<APIService>(new APIService('mock'))
  const exampleServiceRef = useRef<ExampleService>(new ExampleService('mock'))
  const pendingConversationRef = useRef<Conversation | null>(null)

  // Update API and example services when settings change
  useEffect(() => {
    apiServiceRef.current.setProvider(apiProvider || 'mock', apiKey || undefined)
    exampleServiceRef.current.setProvider(apiProvider || 'mock', apiKey || undefined)
  }, [apiProvider, apiKey])

  // Load conversations from localStorage
  useEffect(() => {
    if (isLoaded && state.conversations.length === 0 && storedConversations && storedConversations.length > 0) {
      dispatch({ type: 'LOAD_CONVERSATIONS', conversations: storedConversations })
    }
  }, [isLoaded, storedConversations, state.conversations.length])

  // Save conversations to localStorage when state changes
  useEffect(() => {
    if (isLoaded && state.conversations.length > 0) {
      const conversationsChanged = JSON.stringify(state.conversations) !== JSON.stringify(storedConversations)
      if (conversationsChanged) {
        setStoredConversations(state.conversations)
      }
    }
  }, [state.conversations, isLoaded, storedConversations, setStoredConversations])

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
    
    // Store the conversation temporarily so generateScript can use it immediately
    pendingConversationRef.current = conversation
    dispatch({ type: 'CREATE_CONVERSATION', conversation })
    return conversation
  }, [])

  const generateScript = useCallback(async (request: GenerationRequest): Promise<void> => {
    const startTime = Date.now()
    
    Logger.group('Script Generation')
    Logger.log('Generation', 'Starting generation', {
      prompt: request.prompt.substring(0, 100) + '...',
      conversationId: request.conversationId,
      sectionId: request.sectionId,
      regenerate: request.regenerate,
      provider: apiProvider
    })
    
    try {
      // First check if this is the pending conversation (just created)
      let conversation: Conversation | undefined
      
      if (request.conversationId && pendingConversationRef.current?.id === request.conversationId) {
        Logger.log('Generation', 'Using pending conversation', { id: request.conversationId })
        conversation = pendingConversationRef.current
        pendingConversationRef.current = null // Clear the pending conversation
      } else if (request.conversationId) {
        conversation = state.conversations.find(c => c.id === request.conversationId)
        if (conversation) {
          Logger.log('Generation', 'Found existing conversation', { id: request.conversationId })
        }
      }

      if (!conversation && request.conversationId) {
        Logger.error('Generation', 'Conversation not found', request.conversationId)
        throw new Error('Conversation not found')
      }

      // Set conversation status to generating
      if (conversation) {
        dispatch({ 
          type: 'SET_CONVERSATION_STATUS', 
          conversationId: conversation.id, 
          status: 'generating' 
        })
      }

      // Retrieve relevant examples for the initial prompt (not for regeneration)
      let examples: ExampleScript[] = []
      if (!request.regenerate && exampleServiceRef.current.isConfigured()) {
        Logger.time('Example Retrieval')
        try {
          examples = await exampleServiceRef.current.searchExamples(request.prompt, 3)
          Logger.timeEnd('Example Retrieval')
          Logger.log('Generation', 'Retrieved examples', {
            count: examples.length,
            sizes: examples.map(e => Logger.formatSize(e.content.length))
          })
        } catch (error) {
          Logger.timeEnd('Example Retrieval')
          Logger.warn('Generation', 'Failed to retrieve examples', error)
          // Continue without examples - don't fail the generation
        }
      } else if (request.regenerate) {
        Logger.log('Generation', 'Skipping examples for regeneration')
      }

      // Start generation progress tracking
      dispatch({
        type: 'SET_GENERATION_PROGRESS',
        progress: {
          conversationId: request.conversationId || '',
          sectionId: request.sectionId,
          content: '',
          isComplete: false
        }
      })

      // For regeneration, clear the existing section content to show streaming from start
      if (request.regenerate && request.sectionId && conversation) {
        const existingSection = conversation.sections.find(s => s.id === request.sectionId)
        if (existingSection) {
          dispatch({
            type: 'UPDATE_SECTION',
            conversationId: conversation.id,
            sectionId: existingSection.id,
            updates: { content: '', status: 'generating' }
          })
        }
      }

      let accumulatedContent = ''
      let chunkCount = 0
      let firstChunkTime: number | null = null

      Logger.log('Generation', 'Starting streaming...')
      Logger.time('Streaming Duration')

      // Generate content using the API service
      for await (const chunk of apiServiceRef.current.generateScript(request, conversation, examples)) {
        if (firstChunkTime === null) {
          firstChunkTime = Date.now()
          const timeToFirstChunk = firstChunkTime - startTime
          Logger.log('Generation', `Time to first chunk: ${Logger.formatDuration(timeToFirstChunk)}`)
        }

        accumulatedContent += chunk
        chunkCount++

        // Extract title from accumulated content if we haven't set it yet
        if (conversation && !conversation.title) {
          const titleMatch = accumulatedContent.match(/^#\s+(.+?)(?=\n|$)/m)
          if (titleMatch) {
            const title = titleMatch[1].trim()
            dispatch({
              type: 'SET_CONVERSATION_TITLE',
              conversationId: conversation.id,
              title
            })
            Logger.log('Generation', `Script title detected: "${title}"`)
          }
        }

        // Handle section updates differently for regeneration vs new generation
        if (request.regenerate && request.sectionId && conversation) {
          // For regeneration, update the specific section directly
          const existingSection = conversation.sections.find(s => s.id === request.sectionId)
          if (existingSection) {
            dispatch({
              type: 'UPDATE_SECTION',
              conversationId: conversation.id,
              sectionId: existingSection.id,
              updates: { content: accumulatedContent, status: 'generating' }
            })
          }
        } else {
          // For new generation, parse sections from content
          // Check if we've completed a section (next section started)
          // Skip the main title (single #) and only process sections (##)
          const sectionMatches = accumulatedContent.match(/##\s+(.+?)(?=\n##|\n$|$)/gs)
          if (sectionMatches && sectionMatches.length > 0) {
            const lastSection = sectionMatches[sectionMatches.length - 1]
            const sectionTitle = lastSection.match(/##\s+(.+?)(?=\n|$)/)?.[1]?.trim()

            if (sectionTitle && conversation) {
              // Check if this is a new section
              const existingSection = conversation.sections.find(s => s.title === sectionTitle)
              
              if (!existingSection) {
                Logger.log('Generation', `New section detected: "${sectionTitle}"`)
                // Create new section
                const newSection: ConversationSection = {
                  id: `section_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                  title: sectionTitle,
                  content: lastSection,
                  status: 'generating',
                  messageIds: []
                }

                dispatch({
                  type: 'CREATE_SECTION',
                  conversationId: conversation.id,
                  section: newSection
                })
              } else {
                // Update existing section
                dispatch({
                  type: 'UPDATE_SECTION',
                  conversationId: conversation.id,
                  sectionId: existingSection.id,
                  updates: { content: lastSection, status: 'generating' }
                })
              }
            }
          }
        }

        // Update generation progress
        dispatch({
          type: 'SET_GENERATION_PROGRESS',
          progress: {
            conversationId: request.conversationId || '',
            sectionId: request.sectionId,
            content: accumulatedContent,
            isComplete: false
          }
        })
      }

      Logger.timeEnd('Streaming Duration')
      
      // Log generation summary
      const totalTime = Date.now() - startTime
      const sections = accumulatedContent.match(/##\s+(.+?)(?=\n|$)/gm) || []
      
      Logger.log('Generation', 'Streaming complete', {
        totalTime: Logger.formatDuration(totalTime),
        contentSize: Logger.formatSize(accumulatedContent.length),
        chunkCount,
        sectionsDetected: sections.length,
        sections: sections.map(s => s.replace('##', '').trim())
      })

      // Generation complete
      if (conversation) {
        // Add assistant message with generated content
        const assistantMessage: Message = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          role: 'assistant',
          content: accumulatedContent,
          timestamp: Date.now()
        }

        dispatch({
          type: 'ADD_MESSAGE',
          conversationId: conversation.id,
          message: assistantMessage
        })

        // Mark sections as completed
        if (request.regenerate && request.sectionId) {
          // For regeneration, only mark the specific section as completed
          dispatch({
            type: 'UPDATE_SECTION',
            conversationId: conversation.id,
            sectionId: request.sectionId,
            updates: { status: 'completed' }
          })
        } else {
          // For new generation, mark all sections as completed
          conversation.sections.forEach(section => {
            dispatch({
              type: 'UPDATE_SECTION',
              conversationId: conversation.id,
              sectionId: section.id,
              updates: { status: 'completed' }
            })
          })

          // Check for sections under 400 words and automatically regenerate them
          const shortSections = conversation.sections.filter(section => {
            const wordCount = section.content.split(/\s+/).length
            return wordCount < 400
          })

          if (shortSections.length > 0) {
            Logger.log('Generation', `Found ${shortSections.length} section(s) under 400 words, automatically regenerating`)
            
            // Regenerate the first short section (to avoid overwhelming the system)
            const firstShortSection = shortSections[0]
            Logger.log('Generation', `Auto-regenerating section: "${firstShortSection.title}" (${firstShortSection.content.split(/\s+/).length} words)`)
            
            // Use setTimeout to avoid blocking the current completion
            setTimeout(() => {
              generateScript({
                prompt: `Regenerate the "${firstShortSection.title}" section to be at least 400 words`,
                conversationId: conversation.id,
                sectionId: firstShortSection.id,
                regenerate: true
              }).catch(error => {
                Logger.error('Generation', 'Auto-regeneration failed', error)
              })
            }, 1000) // 1 second delay to let UI update
          }
        }

        dispatch({
          type: 'SET_CONVERSATION_STATUS',
          conversationId: conversation.id,
          status: 'completed'
        })
      }

      // Clear generation progress
      dispatch({
        type: 'SET_GENERATION_PROGRESS',
        progress: {
          conversationId: request.conversationId || '',
          content: accumulatedContent,
          isComplete: true
        }
      })

      Logger.groupEnd()
      Logger.log('Generation', 'Generation completed successfully')
      
    } catch (error) {
      const errorTime = Date.now() - startTime
      Logger.error('Generation', `Generation failed after ${Logger.formatDuration(errorTime)}`, error)
      Logger.groupEnd()
      
      if (request.conversationId) {
        dispatch({
          type: 'SET_CONVERSATION_STATUS',
          conversationId: request.conversationId,
          status: 'error'
        })
      }

      dispatch({
        type: 'SET_GENERATION_PROGRESS',
        progress: {
          conversationId: request.conversationId || '',
          content: '',
          isComplete: true,
          error: error instanceof Error ? error.message : 'Generation failed'
        }
      })
    }
  }, [state.conversations])

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