import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type OpenAI from 'openai'
import { streamOpenAiCompatible } from '../openAiCompatibleStream'
import type { ProviderFrame } from '../providerFrame'
import { clearTranscripts, getTranscripts } from '../debugTranscript'

// The loop is a pure async generator over an injected client, so the whole
// surface can be exercised by scripting the chunks the client hands back.
// Nothing here talks to a provider.

interface ScriptedDelta {
  content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface ScriptedChunk {
  choices?: Array<{ delta?: ScriptedDelta; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

// What the client was asked to send, so a test can assert on the payload
// without owning its exact shape — another caller is free to add fields.
interface CapturedRequest {
  payload: Record<string, unknown>
  options: Record<string, unknown>
}

interface FakeClient {
  client: OpenAI
  requests: CapturedRequest[]
}

// `chunks` may end with a thrown error, which is how the SDK reports both a
// user abort and a genuine transport failure: it rejects mid-iteration.
const fakeClient = (chunks: ScriptedChunk[], options?: { throwAfter?: () => unknown }): FakeClient => {
  const requests: CapturedRequest[] = []
  const create = (payload: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
    requests.push({ payload, options: requestOptions })
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk
        }
        if (options?.throwAfter) throw options.throwAfter()
      }
    })
  }
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    requests
  }
}

const messages = [{ role: 'user' as const, content: 'Write a script about falling' }]

const collect = async (stream: AsyncGenerator<ProviderFrame, void, unknown>): Promise<ProviderFrame[]> => {
  const frames: ProviderFrame[] = []
  for await (const frame of stream) {
    frames.push(frame)
  }
  return frames
}

const run = (
  chunks: ScriptedChunk[],
  overrides: Partial<Parameters<typeof streamOpenAiCompatible>[0]> = {},
  clientOptions?: { throwAfter?: () => unknown }
): { frames: Promise<ProviderFrame[]>; requests: CapturedRequest[] } => {
  const fake = fakeClient(chunks, clientOptions)
  const stream = streamOpenAiCompatible({
    client: fake.client,
    provider: 'openai',
    model: 'gpt-test',
    messages,
    label: 'Generation',
    ...overrides
  })
  return { frames: collect(stream), requests: fake.requests }
}

const textChunk = (content: string): ScriptedChunk => ({ choices: [{ delta: { content } }] })

// Capture is read off window.localStorage, which does not exist under the node
// test environment, so it is stubbed rather than assumed — off by default, and
// switched on only by the tests that assert on what was recorded.
const stubTranscriptCapture = (enabled: boolean): void => {
  const store = new Map<string, string>([['debugTranscripts', JSON.stringify(enabled)]])
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key)
    }
  })
}

beforeEach(() => {
  clearTranscripts()
  stubTranscriptCapture(false)
  // The loop logs the outbound payload and the cache hit rate on every request
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('streamOpenAiCompatible text frames', () => {
  it('yields every text delta in order with nothing lost', async () => {
    const { frames } = run([textChunk('Once '), textChunk('upon '), textChunk('a time')])

    const text = (await frames).filter(frame => frame.kind === 'text')
    expect(text).toEqual([
      { kind: 'text', delta: 'Once ' },
      { kind: 'text', delta: 'upon ' },
      { kind: 'text', delta: 'a time' }
    ])
  })

  it('ignores empty and absent content rather than emitting blank frames', async () => {
    const { frames } = run([
      { choices: [{ delta: {} }] },
      textChunk(''),
      textChunk('real'),
      { choices: [] }
    ])

    expect((await frames).filter(frame => frame.kind === 'text')).toEqual([
      { kind: 'text', delta: 'real' }
    ])
  })
})

describe('streamOpenAiCompatible firstToken', () => {
  it('emits firstToken exactly once, before the first text frame', async () => {
    const { frames } = run([textChunk('a'), textChunk('b'), textChunk('c')])
    const collected = await frames

    expect(collected.filter(frame => frame.kind === 'firstToken')).toHaveLength(1)
    expect(collected[0].kind).toBe('firstToken')
    expect(collected[1]).toEqual({ kind: 'text', delta: 'a' })
  })

  it('emits firstToken on a tool-call delta when no text precedes it', async () => {
    const { frames } = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'outline_write', arguments: '{' } }] } }] },
      textChunk('trailing prose')
    ])
    const collected = await frames

    expect(collected.filter(frame => frame.kind === 'firstToken')).toHaveLength(1)
    expect(collected[0].kind).toBe('firstToken')
    expect(collected[1].kind).toBe('toolCall')
  })
})

describe('streamOpenAiCompatible tool calls', () => {
  it('carries id and name on every frame though the provider sends them only once', async () => {
    // This is the shape that motivates keying on index: after the opening
    // delta the provider sends nothing but the index and a fragment.
    const { frames } = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'section_write', arguments: '{"title":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Opening"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }
    ])

    expect((await frames).filter(frame => frame.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', index: 0, id: 'call_abc', name: 'section_write', argumentsDelta: '{"title":' },
      { kind: 'toolCall', index: 0, id: 'call_abc', name: 'section_write', argumentsDelta: '"Opening"' },
      { kind: 'toolCall', index: 0, id: 'call_abc', name: 'section_write', argumentsDelta: '}' }
    ])
  })

  it('keeps two interleaved calls apart by index', async () => {
    const { frames } = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'section_write', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'section_revise', arguments: '{"b":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }] }
    ])
    const calls = (await frames).filter(frame => frame.kind === 'toolCall')

    expect(calls.map(call => [call.index, call.id, call.name, call.argumentsDelta])).toEqual([
      [0, 'call_a', 'section_write', '{"a":'],
      [1, 'call_b', 'section_revise', '{"b":'],
      [0, 'call_a', 'section_write', '1}'],
      [1, 'call_b', 'section_revise', '2}']
    ])
  })

  it('emits one frame per delta rather than buffering a complete call', async () => {
    const fragments = ['{', '"title"', ':', '"X"', '}']
    const { frames } = run(
      fragments.map(fragment => ({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }]
      }))
    )
    const calls = (await frames).filter(frame => frame.kind === 'toolCall')

    expect(calls).toHaveLength(fragments.length)
    expect(calls.map(call => call.argumentsDelta)).toEqual(fragments)
  })

  it('emits a frame for an opening delta that carries identity but no arguments yet', async () => {
    const { frames } = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'grounding_select' } }] } }] }
    ])

    expect((await frames).filter(frame => frame.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', index: 0, id: 'call_a', name: 'grounding_select', argumentsDelta: '' }
    ])
  })

  it('yields tool-call frames alongside text in the order the provider sent them', async () => {
    const { frames } = run([
      textChunk('thinking aloud'),
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'outline_write', arguments: '{}' } }] } }] },
      textChunk('after')
    ])

    expect((await frames).map(frame => frame.kind)).toEqual([
      'firstToken',
      'text',
      'toolCall',
      'text'
    ])
  })
})

describe('streamOpenAiCompatible finish reasons', () => {
  it.each(['tool_calls', 'stop', 'length', 'content_filter'])(
    'reports the provider finish_reason %s verbatim',
    async reason => {
      const { frames } = run([textChunk('body'), { choices: [{ delta: {}, finish_reason: reason }] }])

      expect((await frames).filter(frame => frame.kind === 'finished')).toEqual([
        { kind: 'finished', reason }
      ])
    }
  )

  it('emits no finished frame when the provider never sends a finish_reason', async () => {
    const { frames } = run([textChunk('body'), { choices: [{ delta: {}, finish_reason: null }] }])

    expect((await frames).some(frame => frame.kind === 'finished')).toBe(false)
  })
})

describe('streamOpenAiCompatible usage', () => {
  it('requests usage on every stream and yields it when the provider sends it', async () => {
    const { frames, requests } = run([
      textChunk('body'),
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 768 } }
      }
    ])
    const collected = await frames

    expect(collected.filter(frame => frame.kind === 'usage')).toEqual([
      { kind: 'usage', promptTokens: 900, completionTokens: 120, cachedTokens: 768 }
    ])
    // Without include_usage the provider sends no usage block at all
    expect(requests[0].payload).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('yields usage without cached tokens when the provider reports none', async () => {
    const { frames } = run([{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }])

    expect((await frames).filter(frame => frame.kind === 'usage')).toEqual([
      { kind: 'usage', promptTokens: 10, completionTokens: 4, cachedTokens: undefined }
    ])
  })
})

describe('streamOpenAiCompatible request payload', () => {
  it('merges caller extras into the payload and passes the abort signal to the client', async () => {
    const controller = new AbortController()
    const { frames, requests } = run([textChunk('x')], {
      extras: { temperature: 0.7, prompt_cache_key: 'cache-key' },
      abortSignal: controller.signal
    })
    await frames

    expect(requests).toHaveLength(1)
    expect(requests[0].payload).toMatchObject({
      model: 'gpt-test',
      messages,
      stream: true,
      temperature: 0.7,
      prompt_cache_key: 'cache-key'
    })
    expect(requests[0].options).toMatchObject({ signal: controller.signal })
  })
})

describe('streamOpenAiCompatible abort and failure', () => {
  it('returns cleanly on abort and still delivers the frames that preceded it', async () => {
    const controller = new AbortController()
    const chunks = [textChunk('kept one '), textChunk('kept two')]
    const fake = fakeClient(chunks, {
      throwAfter: () => {
        // The SDK rejects the iteration once the signal fires; the signal is
        // already aborted by the time the loop sees the error.
        controller.abort()
        return new Error('Request was aborted.')
      }
    })

    const frames = await collect(
      streamOpenAiCompatible({
        client: fake.client,
        provider: 'openai',
        model: 'gpt-test',
        messages,
        label: 'Generation',
        abortSignal: controller.signal
      })
    )

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([
      { kind: 'text', delta: 'kept one ' },
      { kind: 'text', delta: 'kept two' }
    ])
  })

  it('propagates an error that is not an abort', async () => {
    const failure = new Error('provider exploded')
    const { frames } = run([textChunk('partial')], {}, { throwAfter: () => failure })

    await expect(frames).rejects.toThrow('provider exploded')
  })

  it('propagates an error even when an abort signal exists but never fired', async () => {
    const controller = new AbortController()
    const { frames } = run(
      [textChunk('partial')],
      { abortSignal: controller.signal },
      { throwAfter: () => new Error('rate limited') }
    )

    await expect(frames).rejects.toThrow('rate limited')
  })
})

describe('streamOpenAiCompatible transcript recording', () => {
  beforeEach(() => {
    stubTranscriptCapture(true)
  })

  it('records the request, the concatenated text and a complete status', async () => {
    const { frames } = run([textChunk('Once '), textChunk('upon a time')], {
      label: 'Opening',
      exampleIds: ['example-1'],
      transcriptParams: { temperature: 0.7 }
    })
    await frames

    const entries = getTranscripts()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      label: 'Opening',
      exampleIds: ['example-1'],
      params: { temperature: 0.7 },
      // appendChunk receives exactly the text deltas, so the recorded reply is
      // their concatenation and carries no tool-call arguments
      response: 'Once upon a time',
      status: 'complete'
    })
    expect(entries[0].messages).toEqual([{ role: 'user', content: 'Write a script about falling' }])
  })

  it('records tool-call arguments separately from the reply text', async () => {
    const { frames } = run([
      textChunk('prose only'),
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'section_write', arguments: '{"title":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Opening"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])
    await frames

    const entry = getTranscripts()[0]
    expect(entry.response).toBe('prose only')
    expect(entry.toolCalls).toEqual([
      { index: 0, name: 'section_write', arguments: '{"title":"Opening"}' }
    ])
    expect(entry.status).toBe('complete')
  })

  it('records usage on the transcript as well as yielding it', async () => {
    const { frames } = run([
      { choices: [], usage: { prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 768 } } }
    ])
    await frames

    expect(getTranscripts()[0].usage).toEqual({
      promptTokens: 900,
      completionTokens: 120,
      cachedTokens: 768
    })
  })

  it('marks the transcript aborted, keeping what streamed before the abort', async () => {
    const controller = new AbortController()
    const fake = fakeClient([textChunk('kept')], {
      throwAfter: () => {
        controller.abort()
        return new Error('Request was aborted.')
      }
    })

    await collect(
      streamOpenAiCompatible({
        client: fake.client,
        provider: 'openai',
        model: 'gpt-test',
        messages,
        label: 'Generation',
        abortSignal: controller.signal
      })
    )

    expect(getTranscripts()[0]).toMatchObject({ response: 'kept', status: 'aborted' })
  })

  it('marks the transcript failed and records the error message', async () => {
    const { frames } = run([textChunk('partial')], {}, { throwAfter: () => new Error('provider exploded') })
    await expect(frames).rejects.toThrow('provider exploded')

    expect(getTranscripts()[0]).toMatchObject({
      response: 'partial',
      status: 'error',
      error: 'provider exploded'
    })
  })
})
