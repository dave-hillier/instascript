import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import { OpenAIService } from './openai'
import { MockAPIService } from './mockApi'
import { VectorStoreService } from './vectorStore'
import { MockVectorStoreService } from './mockVectorStore'

export type APIProvider = 'openai' | 'mock'

export class ServiceFactory {
  static createScriptService(provider: APIProvider, apiKey?: string): ScriptGenerationService {
    console.debug('Creating script service', { provider, hasApiKey: !!apiKey })
    
    if (provider === 'openai' && apiKey) {
      console.debug('Creating OpenAI script service')
      return new OpenAIService(apiKey)
    }
    
    console.debug('Creating Mock script service')
    return new MockAPIService()
  }

  static createExampleService(provider: APIProvider, apiKey?: string): ExampleSearchService {
    console.debug('Creating example service', { provider, hasApiKey: !!apiKey })
    
    if (provider === 'openai' && apiKey) {
      console.debug('Creating OpenAI example service')
      return new VectorStoreService(apiKey)
    }
    
    console.debug('Creating Mock example service')
    return new MockVectorStoreService()
  }
}