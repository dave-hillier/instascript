import { describe, it, expect } from 'vitest'
import { describePrice, generationModelOptions, utilityModelOptions } from '../modelOptions'
import type { CatalogModel } from '../openrouterCatalog'
import {
  OPENAI_MODELS,
  OPENAI_UTILITY_MODELS,
  OPENROUTER_MODELS,
  OPENROUTER_UTILITY_MODELS
} from '../modelPresets'

const model = (
  id: string,
  name: string,
  supportsTools: boolean,
  outputPerMillion?: number
): CatalogModel => ({
  id,
  name,
  supportsTools,
  inputPerMillion: outputPerMillion === undefined ? undefined : outputPerMillion / 4,
  outputPerMillion
})

const catalog: CatalogModel[] = [
  model('x-ai/grok-4.5', 'xAI: Grok 4.5', true, 6),
  model('openai/gpt-5-nano', 'OpenAI: GPT-5 Nano', true, 0.4),
  model('meta/prose-only', 'Prose Only', false, 1)
]

describe('generationModelOptions', () => {
  it('offers only tool-calling models, by name', () => {
    const options = generationModelOptions('openrouter', catalog)

    expect(options.map(option => option.value)).toEqual(['openai/gpt-5-nano', 'x-ai/grok-4.5'])
  })

  it('labels each model with its published price', () => {
    const [nano] = generationModelOptions('openrouter', catalog)

    expect(nano.label).toContain('OpenAI: GPT-5 Nano')
    expect(nano.label).toContain('out per 1M')
  })

  it('falls back to the curated presets when the catalogue is empty', () => {
    expect(generationModelOptions('openrouter', [])).toEqual(OPENROUTER_MODELS)
  })

  it('leaves OpenAI on its own fixed list', () => {
    expect(generationModelOptions('openai', catalog)).toEqual(OPENAI_MODELS)
  })
})

describe('utilityModelOptions', () => {
  it('offers the whole catalogue cheapest first, tool calling or not', () => {
    const options = utilityModelOptions('openrouter', catalog)

    expect(options.map(option => option.value)).toEqual([
      'openai/gpt-5-nano',
      'meta/prose-only',
      'x-ai/grok-4.5'
    ])
  })

  it('falls back to the curated presets when the catalogue is empty', () => {
    expect(utilityModelOptions('openrouter', [])).toEqual(OPENROUTER_UTILITY_MODELS)
    expect(utilityModelOptions('openai', catalog)).toEqual(OPENAI_UTILITY_MODELS)
  })
})

describe('describePrice', () => {
  it('says so when a model publishes no price', () => {
    expect(describePrice(model('a/b', 'B', true))).toBe('price not published')
  })

  it('says free in one word when both sides cost nothing', () => {
    expect(describePrice(model('a/b', 'B', true, 0))).toBe('free')
  })

  it('reads cheap models in cents and dear ones in dollars', () => {
    expect(describePrice(model('a/b', 'B', true, 0.4))).toBe('10c in / 40c out per 1M')
    expect(describePrice(model('e/f', 'F', true, 0.3))).toBe('7.5c in / 30c out per 1M')
    expect(describePrice(model('c/d', 'D', true, 6))).toBe('$1.50 in / $6 out per 1M')
  })
})
