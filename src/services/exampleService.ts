import { VectorStoreService } from './vectorStore'
import { MockVectorStoreService } from './mockVectorStore'
import type { ExampleScript } from './vectorStore'
import type { APIProvider } from './apiService'

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
      console.log('[ExampleService] Initialized with OpenAI provider')
    } else {
      console.log('[ExampleService] Initialized with Mock provider')
    }
  }

  setProvider(provider: APIProvider, apiKey?: string): void {
    const previousProvider = this.provider
    this.provider = provider
    
    if (provider === 'openai' && apiKey) {
      this.vectorStoreService = new VectorStoreService(apiKey)
      console.log('[ExampleService]', `Provider switched from ${previousProvider} to OpenAI`)
    } else {
      console.log('[ExampleService]', `Provider switched from ${previousProvider} to Mock`)
    }
  }

  async searchExamples(query: string, limit: number = 3): Promise<ExampleScript[]> {
    const usingProvider = this.provider === 'openai' && this.vectorStoreService ? 'OpenAI' : 'Mock'
    console.log('[ExampleService]', `Searching examples using ${usingProvider} provider`, {
      query: query.substring(0, 50) + (query.length > 50 ? '...' : ''),
      limit
    })
    
    try {
      if (this.provider === 'openai' && this.vectorStoreService) {
        const examples = await this.vectorStoreService.searchExamples(query, limit)
        console.log('[ExampleService]', `Retrieved ${examples.length} examples from OpenAI`)
        return examples
      } else {
        if (this.provider === 'openai' && !this.vectorStoreService) {
          console.warn('[ExampleService] OpenAI provider selected but not configured, falling back to Mock')
        }
        const examples = await this.mockVectorStoreService.searchExamples(query, limit)
        console.log('[ExampleService]', `Retrieved ${examples.length} examples from Mock`)
        return examples
      }
    } catch (error) {
      console.error('[ExampleService] Failed to search examples', error)
      throw error
    }
  }

  isConfigured(): boolean {
    const configured = this.provider === 'mock' || (this.provider === 'openai' && this.vectorStoreService !== null)
    console.log('[ExampleService]', `Configuration check: ${configured ? 'configured' : 'not configured'}`)
    return configured
  }

  static formatExamplesForPrompt(examples: ExampleScript[]): string {
    return VectorStoreService.formatExamplesForPrompt(examples)
  }
}