import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import type { UtilityModelService } from './utilityModelService'
import { OpenAIService } from './openai'
import { OpenRouterService } from './openrouter'
import { MockAPIService } from './mockApi'
import { OpenAICompatibleUtilityService, MockUtilityService } from './utilityModel'
import { BundledExampleService } from './bundledExamples'
import { UnconfiguredScriptService, UnconfiguredUtilityService } from './unconfiguredProvider'
import { resolveProviderStatus } from './providerStatus'
import { createAppConfig, type AppConfig } from './config'


// The mock is returned only when it is what the user picked. A real provider
// missing its key gets a service that fails with that reason, so a keyless
// session can no longer be mistaken for a bad generation.
export function createScriptService(config?: AppConfig): ScriptGenerationService {
  const appConfig = config || createAppConfig()
  const status = resolveProviderStatus(appConfig)

  switch (status.kind) {
    case 'live':
      return status.provider === 'openrouter'
        ? new OpenRouterService(appConfig.apiKey!)
        : new OpenAIService(appConfig.apiKey!)
    case 'mock':
      return new MockAPIService()
    case 'missing-key':
      return new UnconfiguredScriptService(status.provider)
  }
}

// The small-model service used by background jobs. Same provider and key as
// generation, different model: whatever the utility role is set to.
export function createUtilityService(config?: AppConfig): UtilityModelService {
  const appConfig = config || createAppConfig()
  const status = resolveProviderStatus(appConfig)

  switch (status.kind) {
    case 'live':
      return new OpenAICompatibleUtilityService(
        appConfig.apiKey!,
        status.provider,
        appConfig.utilityModel
      )
    case 'mock':
      return new MockUtilityService()
    case 'missing-key':
      return new UnconfiguredUtilityService(status.provider)
  }
}

export function createExampleService(): ExampleSearchService {
  return new BundledExampleService()
}
