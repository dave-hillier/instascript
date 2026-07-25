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

// Estimated size of the outline context each section request carries: the
// full outline plus the upcoming-sections block (story 8.10) — title and
// one-sentence summary per section, twice over, at a generous line length.
// Reserved up front so example selection leaves room for it.
export const UPCOMING_SECTIONS_CONTEXT_TOKENS = 500

export const CONTEXT_LIMITS = {
  MAX_TOKENS: 120000,
  RESERVED_TOKENS: 20000,
  MIN_EXAMPLES: 3,
  MAX_EXAMPLES: 20,
  DEFAULT_EXAMPLES: 20,
  AVERAGE_EXAMPLE_TOKENS: 4000
} as const
