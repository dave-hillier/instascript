import type { GenerationRequest, Conversation } from '../types/conversation'
import type { ExampleScript } from './vectorStore'
import { OpenAIService } from './openai'
import { MockAPIService } from './mockApi'

export type APIProvider = 'openai' | 'mock'

export class APIService {
  private openaiService: OpenAIService | null = null
  private mockService: MockAPIService
  private provider: APIProvider
  
  constructor(provider: APIProvider = 'mock', apiKey?: string) {
    this.provider = provider
    this.mockService = new MockAPIService()
    
    if (provider === 'openai' && apiKey) {
      this.openaiService = new OpenAIService(apiKey)
      // Initialized with OpenAI provider
    } else {
      // Initialized with Mock provider
    }
  }

  setProvider(provider: APIProvider, apiKey?: string): void {
    this.provider = provider
    
    if (provider === 'openai' && apiKey) {
      this.openaiService = new OpenAIService(apiKey)
      console.log('API Provider switched to OpenAI')
    } else {
      console.log('API Provider switched to Mock')
    }
  }

  async *generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown> {
    console.log(`Starting ${this.provider.toUpperCase()} API generation`, {
      prompt: request.prompt.substring(0, 100) + '...',
      conversationId: request.conversationId,
      sectionId: request.sectionId,
      regenerate: request.regenerate,
      provider: this.provider
    })
    
    let chunkCount = 0
    const startTime = Date.now()
    
    try {
      if (this.provider === 'openai' && this.openaiService) {
        for await (const chunk of this.openaiService.generateScript(request, conversation, examples)) {
          chunkCount++
          yield chunk
        }
      } else {
        if (this.provider === 'openai' && !this.openaiService) {
          console.warn('OpenAI provider selected but not configured, falling back to Mock')
        }
        for await (const chunk of this.mockService.generateScript(request, conversation, examples)) {
          chunkCount++
          yield chunk
        }
      }
      
      const totalTime = Date.now() - startTime
      const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}min`
      
      console.log(`${this.provider.toUpperCase()} API generation completed`, {
        totalTime: formatDuration(totalTime),
        chunkCount,
        provider: this.provider
      })
    } catch (error) {
      console.error(`${this.provider.toUpperCase()} API generation failed:`, error)
      throw error
    }
  }

  isConfigured(): boolean {
    const configured = this.provider === 'mock' || (this.provider === 'openai' && this.openaiService !== null)
    // Configuration checked
    return configured
  }
}