import { describe, it, expect, afterEach } from 'vitest'
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
import { setCachedCatalog } from '../openrouterCatalog'
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
    // Neither generation recorded what the provider billed, so both were
    // estimated
    expect(totals.measuredCount).toBe(0)
  })

  it('returns zeros for an empty conversation', () => {
    const totals = estimateConversationTokens({
      id: 'c1',
      scriptId: 's1',
      generations: [],
      createdAt: 1,
      updatedAt: 1
    })
    expect(totals).toEqual({ inputTokens: 0, outputTokens: 0, generationCount: 0, measuredCount: 0 })
  })
})

describe('estimateCostUsd', () => {
  it('prices known models from the static table', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      'gpt-5'
    )
    expect(cost).toBeCloseTo(1.25 + 5, 10)
  })

  it('returns null for unknown models', () => {
    expect(
      estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, 'some/custom-model')
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


describe('estimateConversationTokens with real provider usage', () => {
  it('counts what the provider billed instead of guessing at the characters', () => {
    const conversation = makeConversation()
    conversation.generations[0].metrics = {
      startedAt: 1,
      endedAt: 2,
      promptTokens: 1_000,
      completionTokens: 400,
      cachedTokens: 768,
      finishReason: 'stop'
    }
    conversation.generations[1].metrics = {
      startedAt: 3,
      endedAt: 4,
      promptTokens: 2_000,
      completionTokens: 500,
      finishReason: 'stop'
    }

    const totals = estimateConversationTokens(conversation)

    // The character heuristic would have said 510 / 300 for this conversation
    expect(totals.inputTokens).toBe(3_000)
    expect(totals.outputTokens).toBe(900)
    expect(totals.measuredCount).toBe(2)
  })

  it('keeps the estimate for a generation that predates metrics', () => {
    const conversation = makeConversation()
    conversation.generations[1].metrics = {
      startedAt: 3,
      endedAt: 4,
      promptTokens: 2_000,
      completionTokens: 500
    }

    const totals = estimateConversationTokens(conversation)

    // Generation 0 is still estimated at 150 in / 200 out; generation 1 is
    // measured. Without the fallback the older half of the conversation would
    // silently read as free.
    expect(totals.inputTokens).toBe(150 + 2_000)
    expect(totals.outputTokens).toBe(200 + 500)
    expect(totals.generationCount).toBe(2)
    expect(totals.measuredCount).toBe(1)
  })

  it('falls back per side, for a provider that reported only one of them', () => {
    const conversation = makeConversation()
    conversation.generations[0].metrics = { startedAt: 1, endedAt: 2, completionTokens: 400 }
    conversation.generations[1].metrics = { startedAt: 3, endedAt: 4 }

    const totals = estimateConversationTokens(conversation)

    expect(totals.inputTokens).toBe(510)
    expect(totals.outputTokens).toBe(400 + 100)
    expect(totals.measuredCount).toBe(1)
  })

  // The mirror of the case above: a provider that reported the prompt side and
  // nothing else. The prompt figure alone is enough to count the generation as
  // measured, exactly as the completion figure alone is.
  it('counts a generation measured on a prompt figure the provider reported alone', () => {
    const conversation = makeConversation()
    conversation.generations[0].metrics = { startedAt: 1, endedAt: 2, promptTokens: 1_000 }
    conversation.generations[1].metrics = { startedAt: 3, endedAt: 4 }

    const totals = estimateConversationTokens(conversation)

    // Generation 0's input is the reported 1000, its output still the
    // estimated 200; generation 1 is estimated on both sides
    expect(totals.inputTokens).toBe(1_000 + 360)
    expect(totals.outputTokens).toBe(200 + 100)
    expect(totals.measuredCount).toBe(1)
  })
})

// The pricing table above covers the curated presets; everything else settings
// now offers is priced by the catalogue it was picked from.
describe('estimateCostUsd, against the fetched catalogue', () => {
  afterEach(() => {
    setCachedCatalog([], 0)
  })

  it('prices a catalogue model the static table has never heard of', () => {
    setCachedCatalog([
      {
        id: 'vendor/new-model',
        name: 'New Model',
        supportsTools: true,
        inputPerMillion: 2,
        outputPerMillion: 10
      }
    ])

    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, 'vendor/new-model')

    expect(cost).toBeCloseTo(3)
  })

  it('shows no cost for a catalogue model with no published price', () => {
    setCachedCatalog([{ id: 'vendor/unpriced', name: 'Unpriced', supportsTools: true }])

    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, 'vendor/unpriced')).toBeNull()
  })
})
