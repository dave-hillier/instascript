// What a provider stream carries, once it is no longer just prose. A model
// that writes by calling tools emits argument fragments, not only content
// deltas, and the same stream also reports when the first token arrived, what
// the request cost, and why the provider stopped. A plain
// `AsyncGenerator<string>` can carry exactly one of those, so every consumer
// that wants any of the rest has to be told out of band. A discriminated union
// carries all of them in order, and a consumer that only wants prose filters
// on a single discriminant.

export interface ProviderTextFrame {
  kind: 'text'
  delta: string
}

// One delta of one tool call. The provider sends a call's arguments in
// fragments, so `argumentsDelta` is a fragment of a JSON document, not a
// document. `index` identifies the call within the message and is the only
// field present on every delta — `id` and `name` arrive with the first
// fragment of each call, and the stream repeats them here so a consumer never
// has to remember which call it is reading.
export interface ProviderToolCallFrame {
  kind: 'toolCall'
  index: number
  id?: string
  name?: string
  argumentsDelta: string
}

// What a reasoning model emits before it answers. It is NOT part of the
// script: nothing here is ever written into a section, and the frame exists
// only so a caller can show that the model is working. Without it a reasoning
// model looks identical to a stalled request — on this app's own measurements
// a section can sit silent for thirty seconds and then arrive whole, because
// the model spends that time thinking and emits the tool call in one burst at
// the end.
export interface ProviderThinkingFrame {
  kind: 'thinking'
  delta: string
}

// Emitted once per request, at the first delta of either kind, so latency to
// first token is measured where it happens rather than inferred afterwards.
export interface ProviderFirstTokenFrame {
  kind: 'firstToken'
  at: number
}

export interface ProviderUsageFrame {
  kind: 'usage'
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

// The provider's own finish_reason. It matters that this is reported rather
// than assumed: a stream that ends without it ended early, and a tool call
// whose arguments merely happen to parse at the point of an abort must not be
// mistaken for one the model finished writing.
export interface ProviderFinishedFrame {
  kind: 'finished'
  reason: string | null
}

export type ProviderFrame =
  | ProviderTextFrame
  | ProviderToolCallFrame
  | ProviderThinkingFrame
  | ProviderFirstTokenFrame
  | ProviderUsageFrame
  | ProviderFinishedFrame

export type ProviderFrameStream = AsyncIterable<ProviderFrame>

export function isTextFrame(frame: ProviderFrame): frame is ProviderTextFrame {
  return frame.kind === 'text'
}

export function isToolCallFrame(frame: ProviderFrame): frame is ProviderToolCallFrame {
  return frame.kind === 'toolCall'
}

export function isThinkingFrame(frame: ProviderFrame): frame is ProviderThinkingFrame {
  return frame.kind === 'thinking'
}
