import type { GenerationRequest, Conversation } from '../types/conversation'
import type { ExampleScript } from './vectorStore'
import { OpenAIService } from './openai'
import { MockAPIService } from './mockApi'
import { Logger } from '../utils/logger'

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
      Logger.log('APIService', 'Initialized with OpenAI provider')
    } else {
      Logger.log('APIService', 'Initialized with Mock provider')
    }
  }

  setProvider(provider: APIProvider, apiKey?: string): void {
    const previousProvider = this.provider
    this.provider = provider
    
    if (provider === 'openai' && apiKey) {
      this.openaiService = new OpenAIService(apiKey)
      Logger.log('APIService', `Provider switched from ${previousProvider} to OpenAI`)
    } else {
      Logger.log('APIService', `Provider switched from ${previousProvider} to Mock`)
    }
  }

  async *generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown> {
    const usingProvider = this.provider === 'openai' && this.openaiService ? 'OpenAI' : 'Mock'
    Logger.log('APIService', `Generating script using ${usingProvider} provider`)
    
    if (this.provider === 'openai' && this.openaiService) {
      yield* this.openaiService.generateScript(request, conversation, examples)
    } else {
      if (this.provider === 'openai' && !this.openaiService) {
        Logger.warn('APIService', 'OpenAI provider selected but not configured, falling back to Mock')
      }
      yield* this.mockService.generateScript(request, conversation, examples)
    }
  }

  isConfigured(): boolean {
    const configured = this.provider === 'mock' || (this.provider === 'openai' && this.openaiService !== null)
    Logger.log('APIService', `Configuration check: ${configured ? 'configured' : 'not configured'}`)
    return configured
  }
}