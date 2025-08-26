/**
 * Utility functions for managing context window and token estimation
 */

/**
 * Rough estimation of tokens for text content
 * GPT models generally use ~4 characters per token for English text
 */
export function estimateTokenCount(text: string): number {
  // Simple estimation: ~4 characters per token
  return Math.ceil(text.length / 4)
}

/**
 * Calculate optimal number of examples based on available context window
 * GPT-5 has a very large context window (~200k tokens), but we want to be conservative
 * and leave plenty of room for the conversation and generation
 */
export function calculateOptimalExampleCount(
  systemPromptLength: number,
  conversationLength: number = 0,
  averageExampleTokens: number = 500, // tokens per example
  maxContextWindow: number = 180000, // Conservative estimate for GPT-5
  reservedTokens: number = 20000 // Reserve tokens for generation and safety
): number {
  const availableTokens = maxContextWindow - reservedTokens - systemPromptLength - conversationLength
  
  const maxExamplesFromContext = Math.floor(availableTokens / averageExampleTokens)
  
  // Practical limits: minimum 3, maximum 12 examples
  const minExamples = 3
  const maxExamples = 12
  
  return Math.max(minExamples, Math.min(maxExamples, maxExamplesFromContext))
}

/**
 * Get the recommended number of examples for the current context
 * This is the main function to use for determining example count
 */
export function getRecommendedExampleCount(
  systemPrompt?: string,
  conversationTokens: number = 0
): number {
  // Default to larger number of examples since GPT-5 has a large context window
  const defaultCount = 6
  
  if (!systemPrompt) {
    return defaultCount
  }
  
  const systemTokens = estimateTokenCount(systemPrompt)
  return calculateOptimalExampleCount(systemTokens, conversationTokens)
}

/**
 * Constants for context window management
 */
export const CONTEXT_LIMITS = {
  GPT_5_MAX_TOKENS: 200000,
  RESERVED_TOKENS: 20000,
  MIN_EXAMPLES: 3,
  MAX_EXAMPLES: 12,
  DEFAULT_EXAMPLES: 6,
  AVERAGE_EXAMPLE_TOKENS: 500
} as const