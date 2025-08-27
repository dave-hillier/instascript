import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Conversation, Message, ConversationSection, GenerationRequest, GenerationProgress } from '../types/conversation'
import { ConversationContext } from './ConversationContext'
import type { ConversationContextType } from './ConversationContext'
import { useServices } from '../hooks/useServices'
import type { ExampleScript } from '../services/vectorStore'
import { getRecommendedExampleCount } from '../utils/contextWindow'
import { PromptService } from '../services/prompts'
import { useJobQueue } from '../hooks/useJobQueue'
import { messageBus } from '../services/messageBus'
import { scriptRegenerationService } from '../services/scriptRegenerationService'
import { useRegeneration } from '../hooks/useRegeneration'
import type { GenerateScriptJob, RegenerateSectionJob } from '../types/job'
import type { MessageSubscription } from '../services/messageBus'

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
  | { type: 'STORE_EXAMPLES'; conversationId: string; examples: ExampleScript[] }

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
    
    case 'STORE_EXAMPLES':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, examples: action.examples }
            : conv
        )
      }
    
    default:
      return state
  }
}

type ConversationProviderProps = {
  children: ReactNode
}

const getStoredConversations = (): Conversation[] => {
  try {
    const item = window.localStorage.getItem('conversations')
    return item ? JSON.parse(item) : []
  } catch (error) {
    console.warn('Error loading conversations from localStorage:', error)
    return []
  }
}

const setStoredConversations = (conversations: Conversation[]) => {
  try {
    window.localStorage.setItem('conversations', JSON.stringify(conversations))
  } catch (error) {
    console.error('Error saving conversations to localStorage:', error)
  }
}


export const ConversationProvider = ({ children }: ConversationProviderProps) => {
  const [state, dispatch] = useReducer(conversationReducer, {
    conversations: [],
    currentGeneration: null
  })

  const [isLoaded, setIsLoaded] = useState(false)
  const { scriptService, exampleService } = useServices()
  const pendingConversationRef = useRef<Conversation | null>(null)
  const lastStuckCheckRef = useRef<number>(0)
  const messageSubscriptionsRef = useRef<MessageSubscription[]>([])
  const currentStateRef = useRef<ConversationState>(state)
  
  // Update the current state ref whenever state changes
  useEffect(() => {
    currentStateRef.current = state
  }, [state])
  
  // Job queue integration
  const jobQueue = useJobQueue()
  
  // Regeneration system integration
  const { state: regenerationState, dispatch: regenerationDispatch } = useRegeneration()
  
  // Handle regeneration section request from message bus
  const handleRegenerateSectionRequest = useCallback((payload: {
    scriptId: string
    sectionId: string
    sectionTitle: string
    conversationId: string
  }) => {
    console.debug('Handling regeneration request from message bus', payload)
    
    // Create regeneration job
    const jobData: Omit<RegenerateSectionJob, 'id' | 'createdAt' | 'updatedAt' | 'status'> = {
      type: 'regenerate-section',
      scriptId: payload.scriptId,
      title: `Regenerate ${payload.sectionTitle}`,
      sectionId: payload.sectionId,
      sectionTitle: payload.sectionTitle,
      conversationId: payload.conversationId,
      prompt: `Regenerate the "${payload.sectionTitle}" section to be at least 400 words`
    }
    
    jobQueue.addJob(jobData)
  }, [jobQueue])

  // Handle auto-regeneration check request from service
  const handleAutoRegenerationCheck = useCallback((conversationId: string, currentState?: ConversationState) => {
    // Use current state if provided, otherwise use the closure state
    const stateToUse = currentState || state
    
    console.debug('Handling auto-regeneration check request', { 
      conversationId,
      stateConversationCount: stateToUse.conversations.length,
      stateConversationIds: stateToUse.conversations.map(c => c.id),
      hasPendingConversation: !!pendingConversationRef.current,
      pendingConversationId: pendingConversationRef.current?.id,
      usingCurrentState: !!currentState
    })
    
    // Check both state conversations and pending conversation
    let conversation = stateToUse.conversations.find(c => c.id === conversationId)
    if (!conversation && pendingConversationRef.current?.id === conversationId) {
      conversation = pendingConversationRef.current
      console.debug('Found conversation in pending reference', { conversationId })
    }
    
    if (!conversation) {
      console.warn('Conversation not found for auto-regeneration check', { 
        conversationId,
        stateConversationIds: stateToUse.conversations.map(c => c.id),
        pendingConversationId: pendingConversationRef.current?.id
      })
      return
    }
    
    console.debug('Found conversation for auto-regeneration', {
      conversationId: conversation.id,
      sectionsCount: conversation.sections.length,
      sectionTitles: conversation.sections.map(s => s.title),
      sectionStatuses: conversation.sections.map(s => `${s.title}: ${s.status}`)
    })
    
    // Use the new reducer-based regeneration service
    scriptRegenerationService.handleAutoRegenerationCheck(
      regenerationState, 
      conversation, 
      jobQueue.state.jobs
    )
  }, [state.conversations, jobQueue.state.jobs, regenerationState])
  
  // Set up the service with the dispatch function and auto-regeneration handler
  useEffect(() => {
    scriptRegenerationService.setDispatch(regenerationDispatch)
    scriptRegenerationService.setAutoRegenerationHandler(handleAutoRegenerationCheck)
  }, [regenerationDispatch, handleAutoRegenerationCheck])

  // Setup message bus subscriptions
  useEffect(() => {
    const subscriptions = [
      messageBus.subscribe('REGENERATE_SECTION_REQUESTED', (payload) => {
        handleRegenerateSectionRequest(payload)
      })
      // Removed AUTO_REGENERATION_CHECK_REQUESTED - now handled via direct service calls
    ]
    
    messageSubscriptionsRef.current = subscriptions
    
    return () => {
      subscriptions.forEach(sub => sub.unsubscribe())
    }
  }, [handleRegenerateSectionRequest, handleAutoRegenerationCheck])

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

  // Auto-complete sections that are stuck in generating state
  useEffect(() => {
    if (!jobQueue.isLeader) return // Only leader processes auto-completion

    state.conversations.forEach(conversation => {
      // Check for sections that need to be marked as completed
      // If conversation has "generating" sections but no conversation is currently generating, mark them as completed
      const generatingSections = conversation.sections.filter(section => section.status === 'generating')
      const isCurrentlyGenerating = state.currentGeneration && 
        state.currentGeneration.conversationId === conversation.id && 
        !state.currentGeneration.isComplete
      
      if (generatingSections.length > 0 && !isCurrentlyGenerating) {
        console.debug(`Found ${generatingSections.length} generating sections that should be completed`)
        generatingSections.forEach((section, index) => {
          console.debug(`Marking section ${index + 1} as completed`, { 
            sectionId: section.id, 
            title: section.title,
            currentStatus: section.status,
            wordCount: section.content?.split(/\s+/).filter(word => word.length > 0).length || 0
          })
          dispatch({
            type: 'UPDATE_SECTION',
            conversationId: conversation.id,
            sectionId: section.id,
            updates: { status: 'completed' }
          })
        })
        
        // Trigger auto-regeneration check now that sections are completed
        console.debug('Sections marked as completed, triggering auto-regeneration check', { 
          conversationId: conversation.id,
          sectionsMarkedAsCompleted: generatingSections.length
        })
        
        // Use a longer delay and multiple checks to ensure state updates have propagated
        setTimeout(() => {
          console.debug('First auto-regeneration check attempt')
          handleAutoRegenerationCheck(conversation.id, currentStateRef.current)
        }, 200)
        
        // Backup check in case the first one runs too early
        setTimeout(() => {
          console.debug('Second auto-regeneration check attempt (backup)')
          handleAutoRegenerationCheck(conversation.id, currentStateRef.current)
        }, 1000)
      }
    })
  }, [state.conversations, jobQueue.isLeader, state.currentGeneration, dispatch, handleAutoRegenerationCheck])


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
    
    console.group('Script Generation')
    // API generation will be logged at the service layer
    
    try {
      // First check if this is the pending conversation (just created)
      let conversation: Conversation | undefined
      
      if (request.conversationId && pendingConversationRef.current?.id === request.conversationId) {
        conversation = pendingConversationRef.current
        console.debug('Using pending conversation', { 
          id: request.conversationId, 
          messages: conversation.messages.length, 
          sections: conversation.sections.length 
        })
        pendingConversationRef.current = null // Clear the pending conversation
      } else if (request.conversationId) {
        conversation = state.conversations.find(c => c.id === request.conversationId)
        if (conversation) {
          console.debug('Found existing conversation', { 
            id: request.conversationId, 
            messages: conversation.messages.length, 
            sections: conversation.sections.length 
          })
        }
      }

      if (!conversation && request.conversationId) {
        console.error('Conversation not found', request.conversationId)
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

      // Retrieve or reuse examples
      let examples: ExampleScript[] = []
      
      if (request.regenerate && conversation?.examples) {
        // For regeneration, reuse the same examples from initial generation
        examples = conversation.examples
        console.debug('Reusing stored examples for regeneration', {
          count: examples.length,
          sizes: examples.map(e => (e.content.length < 1024 ? `${e.content.length}B` : e.content.length < 1024 * 1024 ? `${(e.content.length / 1024).toFixed(1)}KB` : `${(e.content.length / (1024 * 1024)).toFixed(2)}MB`))
        })
      } else if (!request.regenerate) {
        // For initial generation, retrieve new examples
        console.time('Example Retrieval')
        try {
          // Calculate optimal number of examples based on context window
          const systemPrompt = PromptService.getSystemPrompt()
          const conversationTokens = conversation ? conversation.messages.reduce((total, msg) => total + msg.content.length, 0) : 0
          const optimalExampleCount = getRecommendedExampleCount(systemPrompt, Math.ceil(conversationTokens / 4))
          
          examples = await exampleService.searchExamples(request.prompt, optimalExampleCount)
          console.timeEnd('Example Retrieval')
          console.debug('Retrieved new examples', {
            requestedCount: optimalExampleCount,
            actualCount: examples.length,
            sizes: examples.map(e => (e.content.length < 1024 ? `${e.content.length}B` : e.content.length < 1024 * 1024 ? `${(e.content.length / 1024).toFixed(1)}KB` : `${(e.content.length / (1024 * 1024)).toFixed(2)}MB`))
          })
          
          // Store examples in conversation for future regeneration use
          if (conversation && examples.length > 0) {
            dispatch({
              type: 'STORE_EXAMPLES',
              conversationId: conversation.id,
              examples
            })
          }
        } catch (error) {
          console.timeEnd('Example Retrieval')
          console.warn('Failed to retrieve examples', error)
          // Continue without examples - don't fail the generation
        }
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
      let titleDetected = false
      const processedSectionTitles = new Set<string>() // Track which section titles we've already created

      console.debug('Starting streaming...')
      console.time('Streaming Duration')

      // Generate content using the script service
      for await (const chunk of scriptService.generateScript(request, conversation, examples)) {
        if (firstChunkTime === null) {
          firstChunkTime = Date.now()
          const timeToFirstChunk = firstChunkTime - startTime
          const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}min`
          console.debug(`Time to first chunk: ${formatDuration(timeToFirstChunk)}`)
        }

        accumulatedContent += chunk
        chunkCount++

        // Extract title from accumulated content if we haven't set it yet
        if (conversation && !conversation.title && !titleDetected) {
          // Only check for title if we have a complete line (ends with newline or is at end)
          const lines = accumulatedContent.split('\n')
          const firstLine = lines[0]
          
          // Check if first line is complete (either has a newline after it, or we're done streaming)
          if (lines.length > 1 || accumulatedContent.endsWith('\n')) {
            const titleMatch = firstLine.match(/^#\s+(.+)$/)
            if (titleMatch) {
              const title = titleMatch[1].trim()
              dispatch({
                type: 'SET_CONVERSATION_TITLE',
                conversationId: conversation.id,
                title
              })
              console.debug(`Script title detected: "${title}"`)
              titleDetected = true
            }
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
          // Split content by section headers
          const lines = accumulatedContent.split('\n')
          let currentSectionStart = -1
          let currentSectionTitle = ''
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            
            // Check if this is a section header
            if (line.match(/^##\s+.+/)) {
              // If we had a previous section, process it
              if (currentSectionStart >= 0 && currentSectionTitle && conversation) {
                const sectionContent = lines.slice(currentSectionStart, i).join('\n').trim()
                
                // Only create the section once (when we first encounter it)
                if (!processedSectionTitles.has(currentSectionTitle)) {
                  const existingSection = conversation.sections.find(s => s.title === currentSectionTitle)
                  
                  if (!existingSection) {
                    console.debug(`New section detected: "${currentSectionTitle}"`)
                    const newSection: ConversationSection = {
                      id: `section_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                      title: currentSectionTitle,
                      content: sectionContent,
                      status: 'generating',
                      messageIds: []
                    }
                    
                    dispatch({
                      type: 'CREATE_SECTION',
                      conversationId: conversation.id,
                      section: newSection
                    })
                    
                    processedSectionTitles.add(currentSectionTitle)
                  } else {
                    // Update existing section with accumulated content
                    dispatch({
                      type: 'UPDATE_SECTION',
                      conversationId: conversation.id,
                      sectionId: existingSection.id,
                      updates: { content: sectionContent, status: 'generating' }
                    })
                  }
                }
              }
              
              // Start tracking new section
              currentSectionStart = i
              currentSectionTitle = line.match(/##\s+(.+?)$/)?.[1]?.trim() || ''
            }
          }
          
          // Handle the last section if it exists (still being streamed)
          if (currentSectionStart >= 0 && currentSectionTitle && conversation) {
            const sectionContent = lines.slice(currentSectionStart).join('\n').trim()
            const existingSection = conversation.sections.find(s => s.title === currentSectionTitle)
            
            if (existingSection) {
              // Update with current content
              dispatch({
                type: 'UPDATE_SECTION',
                conversationId: conversation.id,
                sectionId: existingSection.id,
                updates: { content: sectionContent, status: 'generating' }
              })
            } else if (!processedSectionTitles.has(currentSectionTitle)) {
              // Don't create new section for partial content, wait until we see next section
              // This prevents creating sections prematurely
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

      console.timeEnd('Streaming Duration')
      
      // Log generation summary
      const totalTime = Date.now() - startTime
      const sections = accumulatedContent.match(/##\s+(.+?)(?=\n|$)/gm) || []
      
      const formatSize = (bytes: number) => bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(2)}MB`
      const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}min`
      console.debug('Streaming complete', {
        totalTime: formatDuration(totalTime),
        contentSize: formatSize(accumulatedContent.length),
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
          console.debug('Section marked completed', request.sectionId)
          dispatch({
            type: 'UPDATE_SECTION',
            conversationId: conversation.id,
            sectionId: request.sectionId,
            updates: { status: 'completed' }
          })
          
        } else {
          // For new generation, mark all sections as completed
          // Parse sections from the accumulated content to ensure we get all sections created during streaming
          const sectionMatches = accumulatedContent.match(/##\s+(.+?)(?=\n##|\n$|$)/gs) || []
          
          // Parsing sections from content
          // Found section matches
          
          // Create a list of section titles that should be completed
          const sectionTitlesToComplete = sectionMatches.map(match => {
            const titleMatch = match.match(/##\s+(.+?)(?=\n|$)/)
            return titleMatch ? titleMatch[1].trim() : ''
          }).filter(title => title !== '')
          
          // Processing section titles
          
          // Get the latest conversation state to find section IDs
          const latestConversation = state.conversations.find(c => c.id === conversation.id) || conversation
          
          // Checking conversation sections
          
          // Mark sections as completed by matching titles
          sectionTitlesToComplete.forEach(sectionTitle => {
            const section = latestConversation.sections.find(s => s.title === sectionTitle)
            if (section) {
              console.debug('Section completed', section.id)
              dispatch({
                type: 'UPDATE_SECTION',
                conversationId: conversation.id,
                sectionId: section.id,
                updates: { status: 'completed' }
              })
            } else {
              // Could not find section for title
            }
          })

        }

        // Notify completion for both initial generation and regeneration
        if (request.regenerate) {
          // For section regeneration, notify section completion
          messageBus.publish('SECTION_REGENERATION_COMPLETED', {
            scriptId: conversation.scriptId,
            sectionId: request.sectionId!,
            conversationId: conversation.id,
            content: accumulatedContent
          })
        } else {
          // For initial script generation, notify script completion
          // Note: Auto-regeneration will be triggered after sections are marked as completed
          messageBus.publish('SCRIPT_GENERATION_COMPLETED', {
            conversationId: conversation.id,
            scriptId: conversation.scriptId
          })
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

      console.groupEnd()
      // API generation completion logged at service layer
      
    } catch (error) {
      const errorTime = Date.now() - startTime
      const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}min`
      console.error(`Generation failed after ${formatDuration(errorTime)}`, error)
      console.groupEnd()
      
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

  // Job processing - only if we're the leader
  useEffect(() => {
    if (!jobQueue.isLeader) return
    
    // On first load, reset any jobs stuck in processing state
    const resetStuckJobs = () => {
      const now = Date.now()
      const maxProcessingTime = 10 * 60 * 1000 // 10 minutes
      
      const stuckJobs = jobQueue.state.jobs.filter(job => {
        if (job.status !== 'processing') return false
        const processingTime = now - job.updatedAt
        return processingTime > maxProcessingTime
      })
      
      stuckJobs.forEach(job => {
        const processingTime = Math.round((now - job.updatedAt) / 1000)
        console.warn(`Resetting stuck job: ${job.id} (was processing for ${processingTime}s)`)
        jobQueue.updateJob(job.id, { 
          status: 'queued',
          error: undefined 
        })
      })
      
      if (stuckJobs.length > 0) {
        console.debug(`Reset ${stuckJobs.length} stuck job(s)`)
      }
    }
    
    // Reset stuck jobs immediately when becoming leader
    resetStuckJobs()
    
    const processJobs = async () => {
      // Check for stuck jobs periodically (every 5 minutes)
      const now = Date.now()
      if (now - lastStuckCheckRef.current > 5 * 60 * 1000) {
        resetStuckJobs()
        lastStuckCheckRef.current = now
      }
      
      const processingJob = jobQueue.state.jobs.find(job => job.status === 'processing')
      if (processingJob) {
        // Already processing a job
        return
      }
      
      // Check if there's an active generation that should block regeneration jobs
      const hasActiveGeneration = state.currentGeneration && !state.currentGeneration.isComplete
      
      // Get the next job to process, prioritizing script generation over regeneration
      let queuedJob = jobQueue.state.jobs.find(job => 
        job.status === 'queued' && job.type === 'generate-script'
      )
      
      // If no script generation jobs, get regeneration jobs (but only if no active generation)
      if (!queuedJob && !hasActiveGeneration) {
        queuedJob = jobQueue.state.jobs.find(job => 
          job.status === 'queued' && job.type === 'regenerate-section'
        )
      }
      
      if (!queuedJob) {
        // No jobs to process (or regeneration blocked by active generation)
        if (hasActiveGeneration && jobQueue.state.jobs.some(job => job.status === 'queued' && job.type === 'regenerate-section')) {
          // Logger.log('ConversationProvider', 'Regeneration jobs queued but blocked by active generation')
        }
        return
      }
      
      console.debug(`Processing job: ${queuedJob.id} (${queuedJob.type})`)
      
      try {
        // Mark job as processing
        jobQueue.updateJob(queuedJob.id, { status: 'processing' })
        
        if (queuedJob.type === 'generate-script') {
          const job = queuedJob as GenerateScriptJob
          const request: GenerationRequest = {
            prompt: job.prompt,
            conversationId: job.conversationId
          }
          await generateScript(request)
        } else if (queuedJob.type === 'regenerate-section') {
          const job = queuedJob as RegenerateSectionJob
          const request: GenerationRequest = {
            prompt: job.prompt,
            conversationId: job.conversationId,
            sectionId: job.sectionId,
            regenerate: true
          }
          await generateScript(request)
        }
        
        // Mark job as completed
        jobQueue.updateJob(queuedJob.id, { status: 'completed' })
        console.debug(`Job completed: ${queuedJob.id}`)
        
        // Auto-regeneration check is now handled inside generateScript function
        
      } catch (error) {
        console.error(`Job failed: ${queuedJob.id}`, error)
        jobQueue.updateJob(queuedJob.id, { 
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }
    
    // Start processing immediately, then set interval
    processJobs()
    const interval = setInterval(processJobs, 1000)
    return () => clearInterval(interval)
  }, [jobQueue, generateScript, handleAutoRegenerationCheck])

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