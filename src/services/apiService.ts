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
      console.debug('Provider switched to OpenAI')
    } else {
      console.debug('Provider switched to Mock')
    }
  }

  async *generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown> {
    // Generating script
    
    if (this.provider === 'openai' && this.openaiService) {
      yield* this.openaiService.generateScript(request, conversation, examples)
    } else {
      if (this.provider === 'openai' && !this.openaiService) {
        console.warn('OpenAI provider selected but not configured, falling back to Mock')
      }
      yield* this.mockService.generateScript(request, conversation, examples)
    }
  }

  isConfigured(): boolean {
    const configured = this.provider === 'mock' || (this.provider === 'openai' && this.openaiService !== null)
    // Configuration checked
    return configured
  }
}