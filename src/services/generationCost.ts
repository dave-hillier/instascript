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

// Sums estimated tokens across every generation of the conversation. This
// under-reports: the example corpus is sent with every prose request but never
// stored on the generation, so the exemplar tokens the provider billed for are
// not counted here. The stored exampleIds are what a faithful estimate would
// have to re-measure against.
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
// offered in settings. Unknown models simply have no entry. The Grok 3 pair is
// retired and no longer offered, but conversations generated on them are still
// in libraries and would otherwise lose their cost line.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2 },
  'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  'openai/gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'openai/gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2 },
  'openai/gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  'google/gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'x-ai/grok-4.5': { inputPerMillion: 2, outputPerMillion: 6 },
  'x-ai/grok-4.3': { inputPerMillion: 1.25, outputPerMillion: 2.5 },
  'x-ai/grok-4.20': { inputPerMillion: 1.25, outputPerMillion: 2.5 },
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
