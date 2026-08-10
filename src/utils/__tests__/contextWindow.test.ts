import { describe, it, expect } from 'vitest'
import {
  getRecommendedExampleCount,
  estimateSectionContextTokens
} from '../contextWindow'

describe('estimateSectionContextTokens', () => {
  it('grows with the script the section requests carry', () => {
    expect(estimateSectionContextTokens(7800, 12)).toBeGreaterThan(
      estimateSectionContextTokens(1200, 3)
    )
  })

  it('counts the whole script plus the outline twice over', () => {
    // 3,250 words at ~1.4 tokens a word, plus 12 outline entries twice
    expect(estimateSectionContextTokens(3250, 12)).toBe(5990)
  })
})

describe('getRecommendedExampleCount', () => {
  const systemPrompt = 'x'.repeat(4000) // ~1000 tokens

  it('reserves room for the context each section request carries', () => {
    // A budget with room for exactly four 4000-token examples once the
    // system prompt and conversation are accounted for
    const conversationTokens = 120000 - 20000 - 1000 - 4 * 4000

    const withoutReserve = getRecommendedExampleCount(systemPrompt, conversationTokens)
    const withReserve = getRecommendedExampleCount(
      systemPrompt,
      conversationTokens,
      estimateSectionContextTokens(3250, 12)
    )

    expect(withoutReserve).toBe(4)
    expect(withReserve).toBe(3)
  })

  it('caps the count well below what the window would hold', () => {
    // The window has room for roughly twenty whole scripts; the cap, not the
    // arithmetic, is what decides the count for an ordinary script
    expect(getRecommendedExampleCount(systemPrompt, 0, 0)).toBe(6)
  })

  it('never drops below the minimum example count', () => {
    const count = getRecommendedExampleCount(
      systemPrompt,
      200000,
      estimateSectionContextTokens(3250, 12)
    )
    expect(count).toBe(3)
  })
})
