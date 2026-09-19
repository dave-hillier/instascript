import { describe, it, expect } from 'vitest'
import type { AppConfig } from '../config'
import {
  MissingApiKeyError,
  providerUsedFor,
  resolveProviderStatus,
  unavailableReason
} from '../providerStatus'
import { createScriptService, createUtilityService } from '../serviceFactory'
import { MockAPIService } from '../mockApi'
import { MockUtilityService } from '../utilityModel'
import { UnconfiguredScriptService, UnconfiguredUtilityService } from '../unconfiguredProvider'
import { OpenAIService } from '../openai'
import { OpenRouterService } from '../openrouter'
import { DeferredPiAiService } from '../piAiLoader'

const config = (overrides: Partial<AppConfig>): AppConfig => ({
  apiKey: null,
  apiProvider: 'mock',
  model: 'gpt-5',
  utilityModel: 'gpt-5-nano',
  llmEngine: 'sdk',
  reasoning: 'provider',
  ...overrides
})

describe('resolveProviderStatus', () => {
  it('reports a keyed provider as live', () => {
    expect(resolveProviderStatus(config({ apiProvider: 'openai', apiKey: 'sk-test' })))
      .toEqual({ kind: 'live', provider: 'openai' })
    expect(resolveProviderStatus(config({ apiProvider: 'openrouter', apiKey: 'sk-test' })))
      .toEqual({ kind: 'live', provider: 'openrouter' })
  })

  it('reports the mock only when it was deliberately chosen', () => {
    expect(resolveProviderStatus(config({ apiProvider: 'mock' }))).toEqual({ kind: 'mock' })
  })

  it('distinguishes a keyless real provider from the mock', () => {
    expect(resolveProviderStatus(config({ apiProvider: 'openrouter', apiKey: null })))
      .toEqual({ kind: 'missing-key', provider: 'openrouter' })
    expect(resolveProviderStatus(config({ apiProvider: 'openai', apiKey: '' })))
      .toEqual({ kind: 'missing-key', provider: 'openai' })
  })
})

describe('providerUsedFor', () => {
  it('records the provider that actually served the request', () => {
    expect(providerUsedFor({ kind: 'live', provider: 'openrouter' })).toBe('openrouter')
    expect(providerUsedFor({ kind: 'mock' })).toBe('mock')
  })

  it('never labels an unserved request with the provider that was merely selected', () => {
    expect(providerUsedFor({ kind: 'missing-key', provider: 'openrouter' })).not.toBe('openrouter')
  })
})

describe('unavailableReason', () => {
  it('names the provider whose key is missing', () => {
    const reason = unavailableReason({ kind: 'missing-key', provider: 'openrouter' })
    expect(reason).toContain('OpenRouter')
    expect(reason).toContain('Settings')
  })

  it('is silent when generation can proceed', () => {
    expect(unavailableReason({ kind: 'live', provider: 'openai' })).toBeNull()
    expect(unavailableReason({ kind: 'mock' })).toBeNull()
  })
})

describe('createScriptService', () => {
  it('uses the mock only when the mock is selected', () => {
    expect(createScriptService(config({ apiProvider: 'mock' }))).toBeInstanceOf(MockAPIService)
  })

  // The engine setting decides which library carries the request and nothing
  // else, so the default has to keep landing on exactly the services it always
  // did — a session that never opens the setting must not change path.
  it('keeps a keyed provider on the SDK services by default', () => {
    expect(createScriptService(config({ apiProvider: 'openai', apiKey: 'sk-test' })))
      .toBeInstanceOf(OpenAIService)
    expect(createScriptService(config({ apiProvider: 'openrouter', apiKey: 'sk-test' })))
      .toBeInstanceOf(OpenRouterService)
  })

  // The prototype engine is reached through a loader that pulls pi-ai in on
  // first use, so the library stays out of the bundle every default-engine
  // session downloads.
  it('routes a keyed provider through pi-ai when that engine is chosen', () => {
    expect(createScriptService(config({ apiProvider: 'openai', apiKey: 'sk-test', llmEngine: 'pi' })))
      .toBeInstanceOf(DeferredPiAiService)
    expect(createScriptService(config({ apiProvider: 'openrouter', apiKey: 'sk-test', llmEngine: 'pi' })))
      .toBeInstanceOf(DeferredPiAiService)
  })

  it('never reaches the engine choice without a key', () => {
    expect(createScriptService(config({ apiProvider: 'openai', apiKey: null, llmEngine: 'pi' })))
      .toBeInstanceOf(UnconfiguredScriptService)
  })

  it('does not substitute the mock for a keyless provider', () => {
    const service = createScriptService(config({ apiProvider: 'openrouter', apiKey: null }))
    expect(service).not.toBeInstanceOf(MockAPIService)
    expect(service).toBeInstanceOf(UnconfiguredScriptService)
  })

  it('fails generation with a message naming the missing key', async () => {
    const service = createScriptService(config({ apiProvider: 'openai', apiKey: null }))

    await expect(async () => {
      for await (const _chunk of service.generateScript(
        { prompt: 'a calming script', conversationId: 'c1' }
      )) {
        void _chunk
      }
    }).rejects.toThrow(MissingApiKeyError)
  })

  it('fails section regeneration the same way', async () => {
    const service = createScriptService(config({ apiProvider: 'openai', apiKey: null }))

    await expect(async () => {
      for await (const _chunk of service.regenerateSection(
        { prompt: 'rewrite', conversationId: 'c1', sectionTitle: 'Induction' },
        []
      )) {
        void _chunk
      }
    }).rejects.toThrow(/OpenAI/)
  })
})

describe('createUtilityService', () => {
  it('uses the mock only when the mock is selected', () => {
    expect(createUtilityService(config({ apiProvider: 'mock' }))).toBeInstanceOf(MockUtilityService)
  })

  it('reports a keyless provider as not live rather than inventing results', async () => {
    const service = createUtilityService(config({ apiProvider: 'openrouter', apiKey: null }))

    expect(service).toBeInstanceOf(UnconfiguredUtilityService)
    expect(service.isLive).toBe(false)
    expect(service.model).toContain('OpenRouter')
    await expect(
      service.complete({ job: 'tagging', system: 's', user: 'sleep hypnosis' })
    ).resolves.toBe('')
  })
})
