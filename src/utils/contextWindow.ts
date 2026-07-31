/**
 * Utility functions for managing context window and token estimation.
 * Uses conservative defaults that work across providers (OpenAI, OpenRouter/Grok, etc.)
 */

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Calculate optimal number of examples based on available context window.
 * Examples are included as whole documents (~4000 tokens each for ~3000 word scripts).
 */
export function calculateOptimalExampleCount(
  systemPromptLength: number,
  conversationLength: number = 0,
  averageExampleTokens: number = 4000,
  maxContextWindow: number = 120000, // Conservative: fits Grok 3 (131K), GPT-5 (200K+)
  reservedTokens: number = 20000
): number {
  const availableTokens = maxContextWindow - reservedTokens - systemPromptLength - conversationLength

  const maxExamplesFromContext = Math.floor(availableTokens / averageExampleTokens)

  const minExamples = 3
  const maxExamples = 20

  return Math.max(minExamples, Math.min(maxExamples, maxExamplesFromContext))
}

export function getRecommendedExampleCount(
  systemPrompt?: string,
  conversationTokens: number = 0,
  plannedContextTokens: number = 0
): number {
  const defaultCount = 20

  if (!systemPrompt) {
    return defaultCount
  }

  const systemTokens = estimateTokenCount(systemPrompt)
  return calculateOptimalExampleCount(systemTokens, conversationTokens + plannedContextTokens)
}

// Rough tokens for one outline entry: a title and a one-sentence summary
export const OUTLINE_TOKENS_PER_SECTION = 60

// A section request carries the outline twice over — once whole, once as the
// upcoming-sections block (story 8.10) — plus every word of the script written
// so far, so the reservation grows with the script being written. Reserved up
// front because the examples ride on those requests too.
export function estimateSectionContextTokens(totalWords: number, sectionCount: number): number {
  return Math.ceil(totalWords * 1.4) + sectionCount * OUTLINE_TOKENS_PER_SECTION * 2
}

export const CONTEXT_LIMITS = {
  MAX_TOKENS: 120000,
  RESERVED_TOKENS: 20000,
  MIN_EXAMPLES: 3,
  MAX_EXAMPLES: 20,
  DEFAULT_EXAMPLES: 20,
  AVERAGE_EXAMPLE_TOKENS: 4000
} as const
