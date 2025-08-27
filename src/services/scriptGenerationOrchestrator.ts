import type { Conversation, Message, GenerationRequest } from '../types/conversation'
import type { ExampleScript } from './vectorStore'
import type { ConversationAction } from '../reducers/conversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt } from './prompts'
import { getRecommendedExampleCount } from '../utils/contextWindow'
import { 
  createSection, 
  getSectionTitlesFromContent 
} from '../utils/contentParser'
import { StreamingState } from './streamingState'

export interface ScriptServices {
  scriptService: {
    generateScript(
      request: GenerationRequest, 
      conversation: Conversation | undefined, 
      examples: ExampleScript[], 
      abortSignal?: AbortSignal
    ): AsyncIterable<string>
  }
  exampleService: {
    searchExamples(prompt: string, count: number): Promise<ExampleScript[]>
  }
}

export interface GenerationState {
  accumulatedContent: string
  chunkCount: number
  firstChunkTime: number | null
}

export interface GenerationCallbacks {
  dispatch: (action: ConversationAction) => void
  appDispatch: (action: { type: 'UPDATE_SCRIPT'; scriptId: string; updates: Partial<Script> }) => void
  onRegenerationCheck: (conversationId: string) => void
}

export class ScriptGenerationOrchestrator {
  private services: ScriptServices
  private callbacks: GenerationCallbacks
  private streamingStates: Map<string, StreamingState> = new Map()
  
  constructor(
    services: ScriptServices,
    callbacks: GenerationCallbacks
  ) {
    this.services = services
    this.callbacks = callbacks
  }

  private getStreamingState(conversationId: string): StreamingState {
    let state = this.streamingStates.get(conversationId)
    if (!state) {
      state = new StreamingState(conversationId)
      this.streamingStates.set(conversationId, state)
    }
    return state
  }

  private async retrieveExamples(
    request: GenerationRequest, 
    conversation: Conversation | undefined
  ): Promise<ExampleScript[]> {
    if (request.regenerate && conversation?.examples) {
      // For regeneration, reuse the same examples from initial generation
      console.debug('Reusing stored examples for regeneration', {
        count: conversation.examples.length,
        sizes: conversation.examples.map(e => this.formatSize(e.content.length))
      })
      return conversation.examples
    }

    if (request.regenerate) {
      return []
    }

    // For initial generation, retrieve new examples
    console.time('Example Retrieval')
    try {
      const systemPrompt = getSystemPrompt()
      const conversationTokens = conversation 
        ? conversation.messages.reduce((total, msg) => total + msg.content.length, 0) 
        : 0
      const optimalExampleCount = getRecommendedExampleCount(
        systemPrompt, 
        Math.ceil(conversationTokens / 4)
      )
      
      const examples = await this.services.exampleService.searchExamples(
        request.prompt, 
        optimalExampleCount
      )
      
      console.timeEnd('Example Retrieval')
      console.debug('Retrieved new examples', {
        requestedCount: optimalExampleCount,
        actualCount: examples.length,
        sizes: examples.map(e => this.formatSize(e.content.length))
      })
      
      // Store examples in conversation for future regeneration use
      if (conversation && examples.length > 0) {
        this.callbacks.dispatch({
          type: 'STORE_EXAMPLES',
          conversationId: conversation.id,
          examples
        })
      }
      
      return examples
    } catch (error) {
      console.timeEnd('Example Retrieval')
      console.warn('Failed to retrieve examples', error)
      return []
    }
  }

  private setupGeneration(request: GenerationRequest, conversation?: Conversation): void {
    // Set conversation status to generating
    if (conversation) {
      this.callbacks.dispatch({ 
        type: 'SET_CONVERSATION_STATUS', 
        conversationId: conversation.id, 
        status: 'generating' 
      })
    }

    // Start generation progress tracking
    this.callbacks.dispatch({
      type: 'SET_GENERATION_PROGRESS',
      progress: {
        conversationId: request.conversationId || '',
        sectionId: request.sectionId,
        content: '',
        isComplete: false
      }
    })

    // For regeneration, clear the existing section content
    if (request.regenerate && request.sectionId && conversation) {
      const existingSection = conversation.sections.find(s => s.id === request.sectionId)
      if (existingSection) {
        this.callbacks.dispatch({
          type: 'UPDATE_SECTION',
          conversationId: conversation.id,
          sectionId: existingSection.id,
          updates: { content: '', status: 'generating' }
        })
      }
    }
  }

  private handleTitleDetection(
    content: string, 
    conversation: Conversation,
    streamingState: StreamingState
  ): void {
    // Only process title if we haven't finished processing the first line
    if (streamingState.hasTitleLineCompleted()) {
      return
    }

    const lines = content.split('\n')
    const firstLine = lines[0]
    
    // Check if first line is complete (has a newline after it)
    const firstLineComplete = lines.length > 1 || content.endsWith('\n')
    
    // Extract title from first line
    const titleMatch = firstLine.match(/^#\s+(.*)$/)
    if (titleMatch) {
      const title = titleMatch[1].trim()
      
      // Update title if it's different and non-empty
      if (title && title !== conversation.title) {
        this.callbacks.dispatch({
          type: 'SET_CONVERSATION_TITLE',
          conversationId: conversation.id,
          title
        })
        
        this.callbacks.appDispatch({
          type: 'UPDATE_SCRIPT',
          scriptId: conversation.scriptId,
          updates: { title }
        })
        
        console.debug(`Script title updated: "${title}"`)
      }
      
      streamingState.markTitleDetected()
    }
    
    // Mark title line as complete if it is
    if (firstLineComplete) {
      streamingState.markTitleLineCompleted()
      console.debug('Title line completed, stopping title detection')
    }
  }

  private processIncrementalContent(
    request: GenerationRequest,
    conversation: Conversation,
    fullContent: string,
    newChunk: string
  ): void {
    if (request.regenerate && request.sectionId) {
      // For regeneration, bypass parsing and update the specific section directly
      const existingSection = conversation.sections.find(s => s.id === request.sectionId)
      if (existingSection) {
        this.callbacks.dispatch({
          type: 'UPDATE_SECTION',
          conversationId: conversation.id,
          sectionId: existingSection.id,
          updates: { content: fullContent, status: 'generating' }
        })
      }
      return
    }

    // For new generation, use incremental processing
    const streamingState = this.getStreamingState(conversation.id)
    
    // Process new content for section headers
    this.processNewContentForSections(fullContent, newChunk, conversation, streamingState)
  }

  private processNewContentForSections(
    fullContent: string,
    _newChunk: string, 
    conversation: Conversation,
    streamingState: StreamingState
  ): void {
    const lines = fullContent.split('\n')
    const currentSection = streamingState.getCurrentSection()
    const lastProcessedPos = streamingState.getLastProcessedPosition()
    
    // Look for section headers starting from where we left off
    for (let i = lastProcessedPos; i < lines.length; i++) {
      const line = lines[i]
      
      // Check for section header (## prefix with at least some content)
      const sectionHeaderMatch = line.match(/^##\s+(.+)$/)
      if (sectionHeaderMatch) {
        const sectionTitle = sectionHeaderMatch[1].trim()
        
        // If no current section, or this is at a different line than current section
        if (!currentSection || i !== currentSection.startPosition) {
          // This is a NEW section header we haven't seen before
          if (currentSection) {
            this.finalizeCurrentSection(conversation, streamingState)
          }
          
          // Start tracking the new section
          streamingState.startNewSection(i, sectionTitle)
          this.createNewSection(conversation, streamingState, sectionTitle, fullContent, i)
          
          // Mark this position as processed
          streamingState.setLastProcessedPosition(i + 1)
        } else if (currentSection && i === currentSection.startPosition) {
          // This is the SAME section header we're already tracking, just evolving
          if (sectionTitle !== currentSection.currentTitle) {
            streamingState.updateCurrentSectionTitle(sectionTitle)
            this.updateCurrentSectionTitle(conversation, streamingState, sectionTitle)
          }
        }
        
        // Update section content
        this.updateCurrentSectionContent(conversation, streamingState, fullContent, i)
        break // Process one section header update per chunk
      }
    }
    
    // If we have a current section but found no headers, just update its content
    if (currentSection && currentSection.hasCreatedSection) {
      this.updateCurrentSectionContent(conversation, streamingState, fullContent, currentSection.startPosition)
    }
  }

  private createNewSection(
    conversation: Conversation,
    streamingState: StreamingState,
    title: string,
    content: string,
    startPosition: number
  ): void {
    const currentSection = streamingState.getCurrentSection()
    if (!currentSection || currentSection.hasCreatedSection) return

    const sectionContent = this.extractSectionContent(content, startPosition)
    const newSection = createSection(title || '', sectionContent)
    newSection.id = currentSection.sectionId // Use the ID from streaming state
    
    console.debug(`New section created at line ${startPosition}: "${title || '(empty)'}"`)
    this.callbacks.dispatch({
      type: 'CREATE_SECTION',
      conversationId: conversation.id,
      section: newSection
    })
    
    streamingState.markCurrentSectionCreated()
  }

  private updateCurrentSectionTitle(
    conversation: Conversation,
    streamingState: StreamingState,
    newTitle: string
  ): void {
    const currentSection = streamingState.getCurrentSection()
    if (!currentSection || !currentSection.hasCreatedSection) return

    this.callbacks.dispatch({
      type: 'UPDATE_SECTION',
      conversationId: conversation.id,
      sectionId: currentSection.sectionId,
      updates: { title: newTitle, status: 'generating' }
    })
  }

  private updateCurrentSectionContent(
    conversation: Conversation,
    streamingState: StreamingState,
    fullContent: string,
    sectionStartPosition: number
  ): void {
    const currentSection = streamingState.getCurrentSection()
    if (!currentSection || !currentSection.hasCreatedSection) return

    const sectionContent = this.extractSectionContent(fullContent, sectionStartPosition)
    
    this.callbacks.dispatch({
      type: 'UPDATE_SECTION',
      conversationId: conversation.id,
      sectionId: currentSection.sectionId,
      updates: { content: sectionContent, status: 'generating' }
    })
  }

  private extractSectionContent(fullContent: string, startPosition: number): string {
    const lines = fullContent.split('\n')
    
    // Skip the header line itself (startPosition + 1)
    const contentStartPosition = startPosition + 1
    
    // Find the next complete section header
    const nextSectionIndex = lines.findIndex((line, index) => {
      if (index <= startPosition) return false
      // Only consider it a section if it has meaningful content after "## "
      return line.match(/^##\s+.{2,}/) // At least 2 characters after ##
    })
    
    const endPosition = nextSectionIndex === -1 ? lines.length : nextSectionIndex
    
    // Get the raw content
    const contentLines = lines.slice(contentStartPosition, endPosition)
    
    // Filter out any incomplete section headers at the end
    while (contentLines.length > 0) {
      const lastLine = contentLines[contentLines.length - 1].trim()
      // Remove lines that are just ## or ## with minimal content
      if (lastLine.match(/^##(\s*|\s+.{0,1})$/)) {
        contentLines.pop()
      } else {
        break
      }
    }
    
    return contentLines.join('\n').trim()
  }

  private finalizeCurrentSection(
    _conversation: Conversation,
    streamingState: StreamingState
  ): void {
    // Any final processing for the completed section can go here
    // For now, just log that we're finalizing
    const currentSection = streamingState.getCurrentSection()
    if (currentSection) {
      console.debug(`Finalizing section: "${currentSection.currentTitle}"`)
    }
  }

  private completeGeneration(
    request: GenerationRequest,
    conversation: Conversation,
    content: string,
    totalTime: number,
    chunkCount: number
  ): void {
    // Log generation summary
    const sections = content.match(/##\s+(.+?)(?=\n|$)/gm) || []
    
    console.debug('Streaming complete', {
      totalTime: this.formatDuration(totalTime),
      contentSize: this.formatSize(content.length),
      chunkCount,
      sectionsDetected: sections.length,
      sections: sections.map(s => s.replace('##', '').trim())
    })

    // Add assistant message with generated content
    const assistantMessage: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      role: 'assistant',
      content: content,
      timestamp: Date.now()
    }

    this.callbacks.dispatch({
      type: 'ADD_MESSAGE',
      conversationId: conversation.id,
      message: assistantMessage
    })

    // Mark sections as completed
    if (request.regenerate && request.sectionId) {
      console.debug('Section marked completed', request.sectionId)
      this.callbacks.dispatch({
        type: 'UPDATE_SECTION',
        conversationId: conversation.id,
        sectionId: request.sectionId,
        updates: { status: 'completed' }
      })
    } else {
      // Mark all sections as completed
      const sectionTitles = getSectionTitlesFromContent(content)
      
      sectionTitles.forEach(sectionTitle => {
        const section = conversation.sections.find(s => s.title === sectionTitle)
        if (section) {
          console.debug('Section completed', section.id)
          this.callbacks.dispatch({
            type: 'UPDATE_SECTION',
            conversationId: conversation.id,
            sectionId: section.id,
            updates: { status: 'completed' }
          })
        }
      })
    }

    // Trigger auto-regeneration check after completion
    const delay = request.regenerate ? 200 : 500
    setTimeout(() => {
      this.callbacks.onRegenerationCheck(conversation.id)
    }, delay)

    this.callbacks.dispatch({
      type: 'SET_CONVERSATION_STATUS',
      conversationId: conversation.id,
      status: 'completed'
    })
  }

  private handleGenerationError(
    request: GenerationRequest,
    error: unknown,
    startTime: number
  ): void {
    const errorTime = Date.now() - startTime
    console.error(`Generation failed after ${this.formatDuration(errorTime)}`, error)
    
    if (request.conversationId) {
      this.callbacks.dispatch({
        type: 'SET_CONVERSATION_STATUS',
        conversationId: request.conversationId,
        status: 'error'
      })
    }

    this.callbacks.dispatch({
      type: 'SET_GENERATION_PROGRESS',
      progress: {
        conversationId: request.conversationId || '',
        content: '',
        isComplete: true,
        error: error instanceof Error ? error.message : 'Generation failed'
      }
    })
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60000).toFixed(1)}min`
  }

  async generateScript(
    request: GenerationRequest, 
    conversation: Conversation | undefined,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const startTime = Date.now()
    
    console.group('Script Generation')
    
    try {
      if (!conversation && request.conversationId) {
        throw new Error('Conversation not found')
      }

      if (!conversation) {
        throw new Error('No conversation provided')
      }

      // Retrieve examples
      const examples = await this.retrieveExamples(request, conversation)

      // Setup generation state
      this.setupGeneration(request, conversation)

      // Initialize streaming state
      const state: GenerationState = {
        accumulatedContent: '',
        chunkCount: 0,
        firstChunkTime: null
      }
      
      // Get or create streaming state for this conversation
      const streamingState = this.getStreamingState(conversation.id)
      if (!request.regenerate) {
        // Reset state for new generation, keep for regeneration
        streamingState.reset()
      }

      console.debug('Starting streaming...')
      console.time('Streaming Duration')

      // Generate content using the script service
      for await (const chunk of this.services.scriptService.generateScript(
        request, 
        conversation, 
        examples, 
        abortSignal
      )) {
        if (state.firstChunkTime === null) {
          state.firstChunkTime = Date.now()
          const timeToFirstChunk = state.firstChunkTime - startTime
          console.debug(`Time to first chunk: ${this.formatDuration(timeToFirstChunk)}`)
        }

        state.accumulatedContent += chunk
        state.chunkCount++

        // Handle title detection using streaming state
        this.handleTitleDetection(
          state.accumulatedContent, 
          conversation,
          streamingState
        )

        // Handle section updates with incremental processing
        this.processIncrementalContent(
          request,
          conversation,
          state.accumulatedContent,
          chunk
        )

        // Update generation progress
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          progress: {
            conversationId: request.conversationId || '',
            sectionId: request.sectionId,
            content: state.accumulatedContent,
            isComplete: false
          }
        })
      }

      console.timeEnd('Streaming Duration')

      // Complete generation
      const totalTime = Date.now() - startTime
      this.completeGeneration(
        request, 
        conversation, 
        state.accumulatedContent, 
        totalTime, 
        state.chunkCount
      )

      // Clear generation progress
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        progress: {
          conversationId: request.conversationId || '',
          content: state.accumulatedContent,
          isComplete: true
        }
      })

      console.groupEnd()
      
    } catch (error) {
      this.handleGenerationError(request, error, startTime)
      console.groupEnd()
    }
  }
}