// Cumulative token and cost estimation for a script's conversation
// (story 8.12). A generation that recorded what the provider actually billed
// is counted from THAT; only a generation with no such record falls back to
// the character-based heuristic the context-window sizing uses. Pricing is a
// small static table covering the preset models; anything else shows tokens
// only.

import { estimateTokenCount } from '../utils/contextWindow'
import { findCatalogModel } from './openrouterCatalog'
import type { RawConversation } from '../types/conversation'

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  generationCount: number
  // How many of those generations contributed at least one number the
  // provider reported rather than one this file estimated. The two sides are
  // counted together, so a generation whose provider reported only its
  // completion tokens counts here while its prompt figure is still an
  // estimate: equal to generationCount means every generation carried SOME
  // measurement, not that every figure in the totals is measured; 0 means the
  // whole total is a guess.
  measuredCount: number
}

// Sums tokens across every generation of the conversation, preferring what
// the provider reported over what this file can guess.
//
// The two sides are decided separately, because a provider may report one and
// not the other; each falls back on its own. The estimate is deliberately kept
// rather than replaced: every conversation generated before per-generation
// metrics existed has no usage to read, and its cost line would otherwise drop
// to zero — a silent, plausible, wrong answer.
//
// The estimated path still under-reports: the example corpus is sent with
// every prose request but never stored on the generation, so the exemplar
// tokens the provider billed for are not counted. The stored exampleIds are
// what a faithful estimate would have to re-measure against. The measured path
// has no such gap, which is most of the point of it. It does fold cached
// prompt tokens in at the full input rate, because the pricing table below has
// no cached rate to apply — so a cache-heavy run reads as costlier than it was.
export function estimateConversationTokens(conversation: RawConversation): TokenTotals {
  let inputTokens = 0
  let outputTokens = 0
  let measuredCount = 0

  for (const generation of conversation.generations) {
    const metrics = generation.metrics
    let measured = false

    if (metrics?.promptTokens !== undefined) {
      inputTokens += metrics.promptTokens
      measured = true
    } else {
      for (const message of generation.messages) {
        inputTokens += estimateTokenCount(message.content)
      }
    }

    if (metrics?.completionTokens !== undefined) {
      outputTokens += metrics.completionTokens
      measured = true
    } else {
      outputTokens += estimateTokenCount(generation.response)
    }

    if (measured) measuredCount += 1
  }

  return {
    inputTokens,
    outputTokens,
    generationCount: conversation.generations.length,
    measuredCount
  }
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
  'x-ai/grok-build-0.1': { inputPerMillion: 1, outputPerMillion: 2 },
  'x-ai/grok-4.5': { inputPerMillion: 2, outputPerMillion: 6 },
  'x-ai/grok-4.3': { inputPerMillion: 1.25, outputPerMillion: 2.5 },
  'x-ai/grok-4.20': { inputPerMillion: 1.25, outputPerMillion: 2.5 },
  'x-ai/grok-3': { inputPerMillion: 3, outputPerMillion: 15 },
  'x-ai/grok-3-mini': { inputPerMillion: 0.3, outputPerMillion: 0.5 }
}

// Settings offers OpenRouter's whole catalogue, so most models a script can be
// generated on are not in the table above. The catalogue publishes a price per
// model, which is the same list price the table holds by hand; read it when
// the table has nothing, so the cost line survives the wider choice. A model
// OpenRouter publishes no price for stays unpriced.
function catalogPricing(model: string): ModelPricing | null {
  const catalogued = findCatalogModel(model)
  if (catalogued?.inputPerMillion === undefined || catalogued.outputPerMillion === undefined) {
    return null
  }
  return {
    inputPerMillion: catalogued.inputPerMillion,
    outputPerMillion: catalogued.outputPerMillion
  }
}

// Approximate USD cost of the given token totals at the model's list price,
// or null when the model's pricing is unknown
export function estimateCostUsd(
  totals: Pick<TokenTotals, 'inputTokens' | 'outputTokens'>,
  model: string
): number | null {
  const pricing = MODEL_PRICING[model] ?? catalogPricing(model)
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

