import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import { OpenAIService } from './openai'
import { MockAPIService } from './mockApi'
import { VectorStoreService } from './vectorStore'
import { MockVectorStoreService } from './mockVectorStore'
import { createAppConfig, canUseOpenAI, type AppConfig } from './config'

/**
 * Pure functions to create services based on configuration
 * No internal state or side effects
 */

export function createScriptService(config?: AppConfig): ScriptGenerationService {
  const appConfig = config || createAppConfig()
  
  console.debug('Creating script service', { 
    provider: appConfig.apiProvider, 
    hasApiKey: !!appConfig.apiKey 
  })
  
  if (canUseOpenAI(appConfig)) {
    console.debug('Creating OpenAI script service')
    return new OpenAIService(appConfig.apiKey!)
  }
  
  console.debug('Creating Mock script service')
  return new MockAPIService()
}

export function createExampleService(config?: AppConfig): ExampleSearchService {
  const appConfig = config || createAppConfig()
  
  console.debug('Creating example service', { 
    provider: appConfig.apiProvider, 
    hasApiKey: !!appConfig.apiKey 
  })
  
  if (canUseOpenAI(appConfig)) {
    console.debug('Creating OpenAI example service')
    return new VectorStoreService(appConfig.apiKey!)
  }
  
  console.debug('Creating Mock example service')
  return new MockVectorStoreService()
}