import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import { OpenAIService } from './openai'
import { OpenRouterService } from './openrouter'
import { MockAPIService } from './mockApi'
import { BundledExampleService } from './bundledExamples'
import { createAppConfig, canUseOpenAI, canUseOpenRouter, type AppConfig } from './config'


export function createScriptService(config?: AppConfig): ScriptGenerationService {
  const appConfig = config || createAppConfig()

  if (canUseOpenRouter(appConfig)) {
    return new OpenRouterService(appConfig.apiKey!)
  }

  if (canUseOpenAI(appConfig)) {
    return new OpenAIService(appConfig.apiKey!)
  }

  return new MockAPIService()
}

export function createExampleService(): ExampleSearchService {
  return new BundledExampleService()
}
