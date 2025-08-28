import type { RawConversation, GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './vectorStore'
import type { RawConversationAction } from '../reducers/rawConversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt } from './prompts'
import { getRecommendedExampleCount } from '../utils/contextWindow'

export interface RawScriptServices {
  scriptService: {
    generateScript(
      request: GenerationRequest, 
      messages?: ChatMessage[], 
      examples?: ExampleScript[], 
      abortSignal?: AbortSignal
    ): AsyncIterable<string>
    regenerateSection(
      request: RegenerationRequest,
      messages: ChatMessage[],
      abortSignal?: AbortSignal
    ): AsyncIterable<string>
    getLastRequestMessages?(): ChatMessage[] // New method to get the messages that were sent
  }
  exampleService: {
    searchExamples(prompt: string, count: number): Promise<ExampleScript[]>
  }
}

export interface RawGenerationCallbacks {
  dispatch: (action: RawConversationAction) => void
  appDispatch: (action: { type: 'UPDATE_SCRIPT'; scriptId: string; updates: Partial<Script> }) => void
  saveConversations: (conversations: RawConversation[]) => void
  getCurrentConversations: () => RawConversation[]
}

export class RawScriptGenerationOrchestrator {
  private services: RawScriptServices
  private callbacks: RawGenerationCallbacks
  private activeGenerations = new Set<string>()
  private completedGenerations = new Set<string>()
  private lastSaveTime = 0
  private saveThrottleMs = 1000 // Save at most once per second during streaming
  
  constructor(
    services: RawScriptServices,
    callbacks: RawGenerationCallbacks
  ) {
    this.services = services
    this.callbacks = callbacks
  }

  private async retrieveExamples(
    request: GenerationRequest, 
    conversation: RawConversation | undefined
  ): Promise<ExampleScript[]> {
    console.time('Example Retrieval')
    try {
      const systemPrompt = getSystemPrompt()
      const conversationTokens = conversation 
        ? conversation.generations.reduce((total: number, generation) => total + generation.response.length, 0) 
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
      console.debug('Retrieved examples', {
        requestedCount: optimalExampleCount,
        actualCount: examples.length,
        sizes: examples.map(e => this.formatSize(e.content.length))
      })
      
      return examples
    } catch (error) {
      console.timeEnd('Example Retrieval')
      console.warn('Failed to retrieve examples', error)
      return []
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB'
    return Math.round(bytes / (1024 * 1024)) + 'MB'
  }

  private setupGeneration(conversationId: string, sectionTitle?: string): void {
    // Start generation progress tracking
    this.callbacks.dispatch({
      type: 'SET_GENERATION_PROGRESS',
      conversationId: conversationId,
      isComplete: false,
      sectionTitle: sectionTitle
    })
  }

  private async processStream(
    stream: AsyncIterable<string>,
    conversationId: string,
    abortSignal?: AbortSignal,
    sectionTitle?: string
  ): Promise<void> {
    const generationKey = `${conversationId}-${sectionTitle || 'initial'}`
    
    if (this.activeGenerations.has(generationKey)) {
      return
    }
    
    this.activeGenerations.add(generationKey)
    let accumulatedContent = ''
    
    try {
      for await (const chunk of stream) {
        if (abortSignal?.aborted) {
          throw new Error('Generation aborted')
        }
        
        accumulatedContent += chunk
        
        // Update the current generation with raw response
        this.callbacks.dispatch({
          type: 'UPDATE_CURRENT_GENERATION',
          conversationId,
          response: accumulatedContent
        })
        
        // Save during streaming (throttled to avoid excessive localStorage writes)
        const now = Date.now()
        if (now - this.lastSaveTime > this.saveThrottleMs) {
          this.callbacks.saveConversations(this.callbacks.getCurrentConversations())
          this.lastSaveTime = now
        }
        
        // Update generation progress - but only if not completed
        if (!this.completedGenerations.has(generationKey)) {
          this.callbacks.dispatch({
            type: 'SET_GENERATION_PROGRESS',
            conversationId,
            isComplete: false,
            sectionTitle
          })
        }
      }
      
      // Mark generation as complete - first mark it as completed to prevent further updates
      this.completedGenerations.add(generationKey)
      
      // Dispatch completion actions
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        sectionTitle
      })
      
      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: accumulatedContent
      })
      
      // Save conversations after completion
      this.callbacks.saveConversations(this.callbacks.getCurrentConversations())
      
    } catch (error) {
      console.error('Error processing stream:', error)
      
      // Complete generation with error
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error',
        sectionTitle
      })
      
      throw error
    } finally {
      // Clean up active generation tracking
      this.activeGenerations.delete(generationKey)
      // Don't clean up completedGenerations immediately - keep them to prevent late updates
    }
  }

  async generateScript(
    request: GenerationRequest, 
    conversation?: RawConversation, 
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      if (!conversation) {
        throw new Error('Conversation is required for generation')
      }
      
      this.setupGeneration(conversation.id)
      
      // For new generation, retrieve examples and build fresh messages
      const examples = await this.retrieveExamples(request, conversation)
      
      // Start the generation with empty messages array (will be populated by the service)
      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId: conversation.id,
        messages: []
      })
      
      // Save after starting generation
      this.callbacks.saveConversations(this.callbacks.getCurrentConversations())
      
      // Call the script service for initial generation
      const stream = this.services.scriptService.generateScript(
        request,
        [],
        examples,
        abortSignal
      )
      
      await this.processStream(stream, conversation.id, abortSignal)
      
    } catch (error) {
      console.error('Script generation error:', error)
      
      // Ensure error is reported in generation progress
      if (conversation) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId: conversation.id,
          isComplete: true,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
      
      throw error
    }
  }

  async regenerateSection(
    request: RegenerationRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    try {
      this.setupGeneration(conversation.id, request.sectionTitle)
      
      // Build complete conversation history from all generations
      const messages: ChatMessage[] = []
      
      for (let i = 0; i < conversation.generations.length; i++) {
        const generation = conversation.generations[i]
        
        // Add all messages from this generation (system, user, any intermediate messages)
        messages.push(...generation.messages)
        
        // Add the assistant response for this generation
        if (generation.response) {
          messages.push({
            role: 'assistant',
            content: generation.response
          })
        }
      }
      
      // Add the new regeneration request
      messages.push({
        role: 'user',
        content: request.prompt
      })
      
      console.log('Built complete conversation history for section regeneration:', {
        totalGenerations: conversation.generations.length,
        totalMessages: messages.length,
        messageTypes: messages.map(m => m.role)
      })
      
      // Start the generation with the complete messages array
      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId: conversation.id,
        messages: messages
      })
      
      // Save after starting regeneration
      this.callbacks.saveConversations(this.callbacks.getCurrentConversations())
      
      // Call the script service for section regeneration
      const stream = this.services.scriptService.regenerateSection(
        request,
        messages,
        abortSignal
      )
      
      await this.processStream(stream, conversation.id, abortSignal, request.sectionTitle)
      
    } catch (error) {
      console.error('Section regeneration error:', error)
      
      // Ensure error is reported in generation progress
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId: conversation.id,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })
      
      throw error
    }
  }


}