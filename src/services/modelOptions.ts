// Turns the fetched OpenRouter catalogue into the lists settings offers, and
// falls back to the short curated presets when the catalogue is not on hand.
//
// The two roles want different lists out of the same catalogue. Generation
// drives the model by tool calls, so it is offered only the models that accept
// a `tools` parameter, by name — the choice there is about writing. The
// utility role runs short mechanical jobs, so its list is ordered cheapest
// first, which is the whole basis on which that model should be picked.

import type { APIProvider } from './config'
import {
  OPENAI_MODELS,
  OPENAI_UTILITY_MODELS,
  OPENROUTER_MODELS,
  OPENROUTER_UTILITY_MODELS,
  type ModelOption
} from './modelPresets'
import { byName, byPrice, type CatalogModel } from './openrouterCatalog'

// A price a reader can compare at a glance: whole cents where the model is
// cheap, whole dollars where it is not. Output rate is the one that decides
// what a script costs, so both are shown with output last and labelled.
function formatRate(perMillion: number): string {
  if (perMillion === 0) return 'free'
  if (perMillion < 1) {
    const cents = perMillion * 100
    return `${cents % 1 === 0 ? cents : cents.toFixed(1)}c`
  }
  return `$${perMillion % 1 === 0 ? perMillion : perMillion.toFixed(2)}`
}

export function describePrice(model: CatalogModel): string {
  const { inputPerMillion, outputPerMillion } = model
  if (inputPerMillion === undefined || outputPerMillion === undefined) return 'price not published'
  // OpenRouter's free endpoints price both sides at zero, and "free in / free
  // out per 1M" is a long way of saying one word
  if (inputPerMillion === 0 && outputPerMillion === 0) return 'free'
  return `${formatRate(inputPerMillion)} in / ${formatRate(outputPerMillion)} out per 1M`
}

export function toModelOption(model: CatalogModel): ModelOption {
  return { value: model.id, label: `${model.name} — ${describePrice(model)}` }
}

export function generationModelOptions(
  provider: APIProvider,
  catalog: CatalogModel[]
): ModelOption[] {
  if (provider === 'openai') return OPENAI_MODELS
  const capable = catalog.filter(model => model.supportsTools)
  return capable.length > 0
    ? [...capable].sort(byName).map(toModelOption)
    : OPENROUTER_MODELS
}

export function utilityModelOptions(
  provider: APIProvider,
  catalog: CatalogModel[]
): ModelOption[] {
  if (provider === 'openai') return OPENAI_UTILITY_MODELS
  return catalog.length > 0
    ? [...catalog].sort(byPrice).map(toModelOption)
    : OPENROUTER_UTILITY_MODELS
}
