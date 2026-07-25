// Cumulative token and cost estimation for a script's conversation
// (story 8.12). Token counts use the same character-based heuristic as the
// context-window sizing, so everything shown to the user is labelled as an
// estimate. Pricing is a small static table covering the preset models;
// anything else shows tokens only.

import { estimateTokenCount } from '../utils/contextWindow'
import type { RawConversation } from '../types/conversation'

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  generationCount: number
}

// Sums estimated tokens across every generation of the conversation. Each
// generation's messages array is the complete prompt that was sent (including
// replayed history), so summing them reflects what the provider billed for.
export function estimateConversationTokens(conversation: RawConversation): TokenTotals {
  let inputTokens = 0
  let outputTokens = 0

  for (const generation of conversation.generations) {
    for (const message of generation.messages) {
      inputTokens += estimateTokenCount(message.content)
    }
    outputTokens += estimateTokenCount(generation.response)
  }

  return { inputTokens, outputTokens, generationCount: conversation.generations.length }
}

export interface ModelPricing {
  inputPerMillion: number // USD per 1M input tokens
  outputPerMillion: number // USD per 1M output tokens
}

// Published list prices (USD per million tokens) for the preset models
// offered in settings. Unknown models simply have no entry.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2 },
  'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  'x-ai/grok-3': { inputPerMillion: 3, outputPerMillion: 15 },
  'x-ai/grok-3-mini': { inputPerMillion: 0.3, outputPerMillion: 0.5 }
}

// Approximate USD cost of the given token totals at the model's list price,
// or null when the model's pricing is unknown
export function estimateCostUsd(totals: TokenTotals, model: string): number | null {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return null
  return (
    (totals.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (totals.outputTokens / 1_000_000) * pricing.outputPerMillion
  )
}

// Formats an approximate cost for display; sub-cent costs collapse to a floor
// rather than showing misleading fractional cents
export function formatCostUsd(cost: number): string {
  if (cost > 0 && cost < 0.01) return '< $0.01'
  return `$${cost.toFixed(2)}`
}
