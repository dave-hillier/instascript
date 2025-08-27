import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import { OpenAIService } from './openai'
import { MockAPIService } from './mockApi'
import { VectorStoreService } from './vectorStore'
import { MockVectorStoreService } from './mockVectorStore'

export type APIProvider = 'openai' | 'mock'

export class ServiceFactory {
  private static getApiKey(): string | null {
    try {
      const item = window.localStorage.getItem('OPENAI_API_KEY')
      return item ? JSON.parse(item) : null
    } catch (error) {
      console.warn('Error loading API key from localStorage:', error)
      return null
    }
  }

  private static getApiProvider(): APIProvider {
    try {
      const item = window.localStorage.getItem('apiProvider')
      return item ? JSON.parse(item) : 'mock'
    } catch (error) {
      console.warn('Error loading API provider from localStorage:', error)
      return 'mock'
    }
  }

  static createScriptService(): ScriptGenerationService {
    const provider = this.getApiProvider()
    const apiKey = this.getApiKey()
    console.debug('Creating script service', { provider, hasApiKey: !!apiKey })
    
    if (provider === 'openai' && apiKey) {
      console.debug('Creating OpenAI script service')
      return new OpenAIService(apiKey)
    }
    
    console.debug('Creating Mock script service')
    return new MockAPIService()
  }

  static createExampleService(): ExampleSearchService {
    const provider = this.getApiProvider()
    const apiKey = this.getApiKey()
    console.debug('Creating example service', { provider, hasApiKey: !!apiKey })
    
    if (provider === 'openai' && apiKey) {
      console.debug('Creating OpenAI example service')
      return new VectorStoreService(apiKey)
    }
    
    console.debug('Creating Mock example service')
    return new MockVectorStoreService()
  }
}