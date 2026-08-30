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

// The utility role runs short background jobs, so its presets are ordered by
// price rather than by writing quality: cheapest first, which puts the model
// the role wants at the top of the list and makes it the provider's default.
// A test holds the two utility lists to that order against the pricing table.
export const OPENAI_UTILITY_MODELS: ModelOption[] = [
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5', label: 'GPT-5' },
]

// xAI retired the small Grok 3 tier and its successors are all full-size
// models, so the cheap end of the OpenRouter utility list is other vendors'.
// The whole Grok family is still offered below them for anyone who would
// rather keep every role on one vendor. Grok Build is xAI's coding model
// rather than a small general one; it earns its place here on price alone.
export const OPENROUTER_UTILITY_MODELS: ModelOption[] = [
  { value: 'openai/gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { value: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'x-ai/grok-build-0.1', label: 'Grok Build 0.1' },
  { value: 'x-ai/grok-4.3', label: 'Grok 4.3' },
  { value: 'x-ai/grok-4.20', label: 'Grok 4.20' },
  { value: 'x-ai/grok-4.5', label: 'Grok 4.5' },
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

// Whether a model can be driven by tool calls. Generation asks the model to
// write by calling tools rather than by emitting prose, and a model whose API
// ignores a `tools` payload cannot be driven that way at all: it answers in
// prose and every section is rejected for arriving as text.
//
// The verdict is a static table rather than a runtime probe on purpose.
// OpenRouter publishes `supported_parameters` on /v1/models, OpenAI publishes
// nothing equivalent, so a probe could not be shared between the two providers
// and would turn a single cheap auth check into a capability call per model.
//
// The table can never be complete — the OpenRouter model field takes any id
// the user types — so absence means "not known", not "not capable".
export type ToolCallingSupport = boolean | 'unknown'

// Only ids we can speak to with certainty belong here. The `false` entries are
// models served by a completions endpoint that has no tools parameter at all,
// which are the ones a user is most likely to paste in and then be unable to
// explain the failure of.
export const TOOL_CALLING_SUPPORT: Record<string, boolean> = {
  'gpt-5': true,
  'gpt-5-mini': true,
  'gpt-5-nano': true,
  'openai/gpt-5': true,
  'openai/gpt-5-mini': true,
  'openai/gpt-5-nano': true,
  'google/gemini-2.5-flash-lite': true,
  'x-ai/grok-4.5': true,
  'x-ai/grok-4.3': true,
  'x-ai/grok-4.20': true,
  'x-ai/grok-build-0.1': true,
  'gpt-3.5-turbo-instruct': false,
  'openai/gpt-3.5-turbo-instruct': false
}

// Retired ids resolve first, so a setting saved before a model was withdrawn
// is judged on the successor that will actually serve the request.
export function supportsToolCalling(model: string): ToolCallingSupport {
  const known = TOOL_CALLING_SUPPORT[resolveRetiredModel(model.trim())]
  return known === undefined ? 'unknown' : known
}

// The decision every caller actually makes. An unknown id is treated as
// capable and allowed to try: settings accept any free-text model id, so
// defaulting unknowns to incapable would strand every custom-model user on the
// legacy prose path silently and permanently, which is a far worse failure
// than one clear API error on the first request.
export function canAttemptToolCalling(model: string): boolean {
  return supportsToolCalling(model) !== false
}
