import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEFAULT_MODELS, getModel, getUtilityModel } from '../config'
import { MODEL_PRICING } from '../generationCost'
import {
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  OPENAI_UTILITY_MODELS,
  OPENROUTER_UTILITY_MODELS,
  RETIRED_MODELS,
  resolveRetiredModel
} from '../modelPresets'

// A model id saved by an older build lives in localStorage, so these tests
// need a store to write into. A map is enough: only getItem and setItem are
// ever reached.
const store = new Map<string, string>()

const fakeLocalStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) }
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', { localStorage: fakeLocalStorage })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveRetiredModel', () => {
  it('maps a retired model to its successor', () => {
    expect(resolveRetiredModel('x-ai/grok-3-mini')).toBe('x-ai/grok-4.3')
    expect(resolveRetiredModel('x-ai/grok-3')).toBe('x-ai/grok-4.3')
  })

  it('leaves any other model alone, including custom ids', () => {
    expect(resolveRetiredModel('x-ai/grok-4.5')).toBe('x-ai/grok-4.5')
    expect(resolveRetiredModel('anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4')
  })

  it('names a successor that is itself still offered', () => {
    for (const successor of Object.values(RETIRED_MODELS)) {
      expect(RETIRED_MODELS[successor]).toBeUndefined()
    }
  })
})

describe('stored settings naming a retired model', () => {
  it('generates with the successor rather than the 404', () => {
    store.set('model', JSON.stringify('x-ai/grok-3'))

    expect(getModel()).toBe('x-ai/grok-4.3')
  })

  it('runs utility jobs on the successor rather than the 404', () => {
    store.set('apiProvider', JSON.stringify('openrouter'))
    store.set('utilityModel', JSON.stringify('x-ai/grok-3-mini'))

    expect(getUtilityModel()).toBe('x-ai/grok-4.3')
  })
})

describe('model presets', () => {
  it('offers no model the provider has retired', () => {
    const presets = [
      ...OPENAI_MODELS,
      ...OPENROUTER_MODELS,
      ...OPENAI_UTILITY_MODELS,
      ...OPENROUTER_UTILITY_MODELS
    ]
    for (const preset of presets) {
      expect(RETIRED_MODELS[preset.value], preset.value).toBeUndefined()
    }
  })

  it('defaults each role to a model that is still offered', () => {
    for (const role of ['generation', 'utility'] as const) {
      expect(RETIRED_MODELS[DEFAULT_MODELS.openai[role]]).toBeUndefined()
      expect(RETIRED_MODELS[DEFAULT_MODELS.openrouter[role]]).toBeUndefined()
    }
  })
})

// The utility role exists to keep the small jobs cheap, so the preference is
// expressed in the order of its lists: whichever model sits first is what the
// dropdown opens on and what the provider defaults to. These hold that order
// to the published prices, so a model added in the wrong place is caught here
// rather than by a bill.
describe('utility presets, cheapest first', () => {
  const utilityLists = {
    openai: OPENAI_UTILITY_MODELS,
    openrouter: OPENROUTER_UTILITY_MODELS
  }

  for (const [provider, models] of Object.entries(utilityLists)) {
    it(`orders the ${provider} list by ascending price`, () => {
      for (let i = 1; i < models.length; i++) {
        const previous = MODEL_PRICING[models[i - 1].value]
        const current = MODEL_PRICING[models[i].value]
        const label = `${models[i - 1].value} before ${models[i].value}`

        expect(previous.inputPerMillion, label).toBeLessThanOrEqual(current.inputPerMillion)
        if (previous.inputPerMillion === current.inputPerMillion) {
          expect(previous.outputPerMillion, label).toBeLessThanOrEqual(current.outputPerMillion)
        }
      }
    })

    it(`defaults ${provider} to the head of its utility list`, () => {
      expect(DEFAULT_MODELS[provider as 'openai' | 'openrouter'].utility).toBe(models[0].value)
    })
  }
})
