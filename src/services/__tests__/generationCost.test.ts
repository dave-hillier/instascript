import { describe, it, expect } from 'vitest'
import {
  estimateConversationTokens,
  estimateCostUsd,
  formatCostUsd,
  MODEL_PRICING
} from '../generationCost'
import {
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  OPENAI_UTILITY_MODELS,
  OPENROUTER_UTILITY_MODELS
} from '../modelPresets'
import type { RawConversation } from '../../types/conversation'

const makeConversation = (): RawConversation => ({
  id: 'c1',
  scriptId: 's1',
  generations: [
    {
      messages: [
        { role: 'system', content: 'a'.repeat(400) }, // 100 tokens
        { role: 'user', content: 'b'.repeat(200) } // 50 tokens
      ],
      response: 'c'.repeat(800), // 200 tokens
      timestamp: 1
    },
    {
      messages: [
        { role: 'system', content: 'a'.repeat(400) }, // 100 tokens
        { role: 'user', content: 'b'.repeat(200) }, // 50 tokens
        { role: 'assistant', content: 'c'.repeat(800) }, // 200 tokens
        { role: 'user', content: 'd'.repeat(40) } // 10 tokens
      ],
      response: 'e'.repeat(400), // 100 tokens
      timestamp: 2
    }
  ],
  createdAt: 1,
  updatedAt: 2
})

describe('estimateConversationTokens', () => {
  it('sums input and output tokens across all generations', () => {
    const totals = estimateConversationTokens(makeConversation())

    // Inputs: (100 + 50) + (100 + 50 + 200 + 10) = 510
    expect(totals.inputTokens).toBe(510)
    // Outputs: 200 + 100 = 300
    expect(totals.outputTokens).toBe(300)
    expect(totals.generationCount).toBe(2)
  })

  it('returns zeros for an empty conversation', () => {
    const totals = estimateConversationTokens({
      id: 'c1',
      scriptId: 's1',
      generations: [],
      createdAt: 1,
      updatedAt: 1
    })
    expect(totals).toEqual({ inputTokens: 0, outputTokens: 0, generationCount: 0 })
  })
})

describe('estimateCostUsd', () => {
  it('prices known models from the static table', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000, generationCount: 3 },
      'gpt-5'
    )
    expect(cost).toBeCloseTo(1.25 + 5, 10)
  })

  it('returns null for unknown models', () => {
    expect(
      estimateCostUsd({ inputTokens: 1000, outputTokens: 1000, generationCount: 1 }, 'some/custom-model')
    ).toBeNull()
  })

  // Derived from the preset lists rather than restated, so a model added to
  // settings without a price fails here instead of silently showing no cost
  it('covers every preset model in settings', () => {
    const presets = [
      ...OPENAI_MODELS,
      ...OPENROUTER_MODELS,
      ...OPENAI_UTILITY_MODELS,
      ...OPENROUTER_UTILITY_MODELS
    ]
    for (const preset of presets) {
      expect(MODEL_PRICING[preset.value], preset.value).toBeDefined()
    }
  })
})

describe('formatCostUsd', () => {
  it('formats to whole cents', () => {
    expect(formatCostUsd(1.256)).toBe('$1.26')
    expect(formatCostUsd(0)).toBe('$0.00')
  })

  it('collapses sub-cent costs to a floor', () => {
    expect(formatCostUsd(0.0004)).toBe('< $0.01')
  })
})
