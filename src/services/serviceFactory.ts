import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import type { UtilityModelService } from './utilityModelService'
import { OpenAIService } from './openai'
import { OpenRouterService } from './openrouter'
import { MockAPIService } from './mockApi'
import { OpenAICompatibleUtilityService, MockUtilityService } from './utilityModel'
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

// The small-model service used by background jobs. Same provider and key as
// generation, different model: whatever the utility role is set to.
export function createUtilityService(config?: AppConfig): UtilityModelService {
  const appConfig = config || createAppConfig()

  if (canUseOpenRouter(appConfig)) {
    return new OpenAICompatibleUtilityService(appConfig.apiKey!, 'openrouter', appConfig.utilityModel)
  }

  if (canUseOpenAI(appConfig)) {
    return new OpenAICompatibleUtilityService(appConfig.apiKey!, 'openai', appConfig.utilityModel)
  }

  return new MockUtilityService()
}

export function createExampleService(): ExampleSearchService {
  return new BundledExampleService()
}
