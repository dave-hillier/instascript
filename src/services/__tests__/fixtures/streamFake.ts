import type { ProviderFrame } from '../../providerFrame'

// The one streaming test double. Every test that stands in for a provider
// wants the same thing — a stream that carries some prose — and each file used
// to hand-roll it, so the fakes had already drifted apart in what they emitted
// and when they stopped. A shared fixture means a test asserting on prose does
// not have to know the frame protocol, and means a change to that protocol is
// made in one place rather than found by four failing files.

// A stream shaped the way a real provider's is: first token, then the prose,
// then a clean finish. Tests that only read text see exactly the text they
// passed in; tests exercising the surrounding machinery see the frames a real
// run would deliver around it.
export async function* textFrames(
  ...chunks: string[]
): AsyncGenerator<ProviderFrame, void, unknown> {
  let sawFirstToken = false
  for (const chunk of chunks) {
    if (!sawFirstToken) {
      sawFirstToken = true
      yield { kind: 'firstToken', at: Date.now() }
    }
    yield { kind: 'text', delta: chunk }
  }
  yield { kind: 'finished', reason: 'stop' }
}

// Wraps a caller's own string stream, for the tests whose point is what
// happens *between* chunks — an abort landing mid-stream, or a provider that
// throws part way through. They stay written as plain string generators; only
// the frames around them come from here. No finish frame is emitted, because
// such a stream is precisely one that does not finish cleanly.
export async function* framesFromStrings(
  source: AsyncIterable<string>
): AsyncGenerator<ProviderFrame, void, unknown> {
  let sawFirstToken = false
  for await (const chunk of source) {
    if (!sawFirstToken) {
      sawFirstToken = true
      yield { kind: 'firstToken', at: Date.now() }
    }
    yield { kind: 'text', delta: chunk }
  }
}

// A stream carrying one tool call, as a provider sends one: the id and the
// name arrive with the first fragment and on none after it, and the arguments
// come in pieces that cut the JSON at arbitrary characters. Tests that hand
// over a whole arguments document still exercise the reassembly, which is
// where the tool path's real risk lives.
export async function* toolCallFrames(
  name: string,
  argumentsJson: string,
  options: { id?: string; finishReason?: string | null; fragmentSize?: number } = {}
): AsyncGenerator<ProviderFrame, void, unknown> {
  const { id = 'call_1', fragmentSize = 7 } = options
  const finishReason = options.finishReason === undefined ? 'tool_calls' : options.finishReason

  yield { kind: 'firstToken', at: Date.now() }
  for (let i = 0; i < argumentsJson.length; i += fragmentSize) {
    yield {
      kind: 'toolCall',
      index: 0,
      // Repeated on every frame by the shared streamer, which remembers the
      // identity per index; a test double that omitted them would be easier to
      // satisfy than a real provider
      id,
      name,
      argumentsDelta: argumentsJson.slice(i, i + fragmentSize)
    }
  }

  // A null finish reason stands for a stream that ended without one — an
  // abort, or a provider that dropped the connection
  if (finishReason !== null) yield { kind: 'finished', reason: finishReason }
}
