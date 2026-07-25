import { describe, it, expect } from 'vitest'
import {
  getRecommendedExampleCount,
  UPCOMING_SECTIONS_CONTEXT_TOKENS
} from '../contextWindow'

describe('getRecommendedExampleCount', () => {
  const systemPrompt = 'x'.repeat(4000) // ~1000 tokens

  it('reserves room for planned per-section context (story 8.10)', () => {
    // A budget sized so the reserved upcoming-sections context tips the
    // count down by one example: without the reserve there is exactly room
    // for one more 4000-token example than with it
    const conversationTokens = 120000 - 20000 - 1000 - 4 * 4000 - 400

    const withoutReserve = getRecommendedExampleCount(systemPrompt, conversationTokens)
    const withReserve = getRecommendedExampleCount(
      systemPrompt,
      conversationTokens,
      UPCOMING_SECTIONS_CONTEXT_TOKENS
    )

    expect(withoutReserve).toBe(4)
    expect(withReserve).toBe(3)
  })

  it('never drops below the minimum example count', () => {
    const count = getRecommendedExampleCount(systemPrompt, 200000, UPCOMING_SECTIONS_CONTEXT_TOKENS)
    expect(count).toBe(3)
  })
})
