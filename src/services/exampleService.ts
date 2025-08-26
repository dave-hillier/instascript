import { VectorStoreService } from './vectorStore'
import { MockVectorStoreService } from './mockVectorStore'
import type { ExampleScript } from './vectorStore'
import type { APIProvider } from './apiService'
import { CONTEXT_LIMITS } from '../utils/contextWindow'

/**
 * ExampleService provides access to hypnosis script examples from either:
 * 1. OpenAI File Vector Store (named "hypno-default" with markdown files)
 * 2. Mock examples for testing and development
 * 
 * Examples are retrieved based on user prompts and included in generation requests
 * to provide context and improve script quality.
 */

export class ExampleService {
  private vectorStoreService: VectorStoreService | null = null
  private mockVectorStoreService: MockVectorStoreService
  private provider: APIProvider
  
  constructor(provider: APIProvider = 'mock', apiKey?: string) {
    this.provider = provider
    this.mockVectorStoreService = new MockVectorStoreService()
    
    if (provider === 'openai' && apiKey) {
      this.vectorStoreService = new VectorStoreService(apiKey)
      // Initialized with OpenAI provider
    } else {
      // Initialized with Mock provider
    }
  }

  setProvider(provider: APIProvider, apiKey?: string): void {
    this.provider = provider
    
    if (provider === 'openai' && apiKey) {
      this.vectorStoreService = new VectorStoreService(apiKey)
      console.debug('Provider switched to OpenAI')
    } else {
      console.debug('Provider switched to Mock')
    }
  }

  async searchExamples(query: string, limit: number = CONTEXT_LIMITS.DEFAULT_EXAMPLES): Promise<ExampleScript[]> {
    // Searching examples
    
    try {
      if (this.provider === 'openai' && this.vectorStoreService) {
        const examples = await this.vectorStoreService.searchExamples(query, limit)
        console.debug(`Retrieved ${examples.length} examples from OpenAI:`, examples.map(e => e.metadata?.filename || 'unknown'))
        return examples
      } else {
        if (this.provider === 'openai' && !this.vectorStoreService) {
          console.warn('OpenAI provider selected but not configured, falling back to Mock')
        }
        const examples = await this.mockVectorStoreService.searchExamples(query, limit)
        console.debug(`Retrieved ${examples.length} examples from Mock:`, examples.map(e => e.metadata?.filename || 'unknown'))
        return examples
      }
    } catch (error) {
      console.error('Failed to search examples', error)
      throw error
    }
  }

  isConfigured(): boolean {
    const configured = this.provider === 'mock' || (this.provider === 'openai' && this.vectorStoreService !== null)
    // Configuration checked
    return configured
  }

  static formatExamplesForPrompt(examples: ExampleScript[]): string {
    return VectorStoreService.formatExamplesForPrompt(examples)
  }
}