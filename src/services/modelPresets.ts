// The models offered in settings. They live here rather than in the settings
// component so the pricing table can be checked against them: a preset with no
// published price shows tokens but no cost, which is a silent gap.

export type ModelOption = { value: string; label: string }

export const OPENAI_MODELS: ModelOption[] = [
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
]

export const OPENROUTER_MODELS: ModelOption[] = [
  { value: 'x-ai/grok-4.5', label: 'Grok 4.5' },
  { value: 'x-ai/grok-4.3', label: 'Grok 4.3' },
  { value: 'x-ai/grok-4.20', label: 'Grok 4.20' },
]

// The utility role runs short background jobs, so its presets lead with the
// small fast models rather than the ones chosen for writing quality
export const OPENAI_UTILITY_MODELS: ModelOption[] = [
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5', label: 'GPT-5' },
]

// xAI retired the small Grok 3 tier and its successors are all full-size
// models, so the cheap end of the OpenRouter utility list is other vendors'
export const OPENROUTER_UTILITY_MODELS: ModelOption[] = [
  { value: 'openai/gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { value: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'x-ai/grok-4.3', label: 'Grok 4.3' },
]

// Models the providers have retired, and the successor each read remaps to.
// A model id saved in localStorage outlives the model itself: an install that
// stored the old OpenRouter defaults keeps sending them, and every request
// comes back 404 with nothing in the app to explain it. Remapping on read
// repairs those installs without asking the user to visit settings.
export const RETIRED_MODELS: Record<string, string> = {
  'x-ai/grok-3': 'x-ai/grok-4.3',
  'x-ai/grok-3-mini': 'x-ai/grok-4.3'
}

export function resolveRetiredModel(model: string): string {
  return RETIRED_MODELS[model] ?? model
}
