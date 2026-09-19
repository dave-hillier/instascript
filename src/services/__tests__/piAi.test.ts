import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../../types/conversation'
import type { ProviderFrame } from '../providerFrame'
import { clearTranscripts, getTranscripts } from '../debugTranscript'

// The adapter builds its own pi-ai client rather than taking one, so the seam
// the SDK tests get for free — an injected client — is made here by standing in
// for the package itself. Everything below the event stream is pi-ai's
// business; what matters to instascript is the events it emits and the frames
// they become, so the whole surface is exercised by scripting those events.
// Nothing here talks to a provider.

const piAi = vi.hoisted(() => {
  interface ScriptedEvent {
    type: string
    delta?: string
    contentIndex?: number
    partial?: { content: Array<{ type: string; id?: string; name?: string }> }
    reason?: string
    message?: { usage: Record<string, unknown> }
    error?: { errorMessage?: string; usage?: Record<string, number> }
  }

  interface CapturedRequest {
    model: { id: string; api: string; provider: string; baseUrl: string; reasoning: boolean }
    context: {
      systemPrompt?: string
      messages: Array<Record<string, unknown>>
      tools?: Array<Record<string, unknown>>
    }
    options: { apiKey?: string; signal?: AbortSignal; reasoningEffort?: string }
  }

  // Set per test. `events` is what the stream will yield; `beforeEach`
  // clears both so one test cannot leak into the next.
  const state: {
    events: ScriptedEvent[]
    requests: CapturedRequest[]
    providers: string[]
    providerLoadError: string | null
  } = { events: [], requests: [], providers: [], providerLoadError: null }

  return { state }
})

type ScriptedEvent = (typeof piAi.state.events)[number]

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: () => ({
    setProvider: (provider: { id: string }) => {
      piAi.state.providers.push(provider.id)
    },
    stream: (
      model: (typeof piAi.state.requests)[number]['model'],
      context: (typeof piAi.state.requests)[number]['context'],
      options: (typeof piAi.state.requests)[number]['options']
    ) => {
      piAi.state.requests.push({ model, context, options })
      const events = piAi.state.events
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event
          }
        }
      }
    }
  })
}))

// Only the provider the setting names is ever loaded, so both entry points are
// stood in for and a test can assert which one the adapter reached for.
vi.mock('@earendil-works/pi-ai/providers/openai', () => ({
  openaiProvider: () => {
    // Stands in for the adapter chunk failing to load — offline, or stale
    // after a deploy — which is the one thing in this method that can reject.
    if (piAi.state.providerLoadError) throw new Error(piAi.state.providerLoadError)
    return { id: 'openai' }
  }
}))
vi.mock('@earendil-works/pi-ai/providers/openrouter', () => ({
  openrouterProvider: () => ({ id: 'openrouter' })
}))

const { PiAiService } = await import('../piAi')

type ReasoningLevel = 'provider' | 'off' | 'low' | 'medium' | 'high'

const textDelta = (delta: string): ScriptedEvent => ({ type: 'text_delta', delta })

const thinkingDelta = (delta: string): ScriptedEvent => ({ type: 'thinking_delta', delta })

// A tool-call delta always arrives with the partial message it is filling in;
// the id and name live on that block, never on the delta.
const toolDelta = (
  contentIndex: number,
  delta: string,
  identity?: { id?: string; name?: string }
): ScriptedEvent => ({
  type: 'toolcall_delta',
  contentIndex,
  delta,
  partial: {
    content: Array.from({ length: contentIndex + 1 }, (_unused, index) =>
      index === contentIndex
        ? { type: 'toolCall', id: identity?.id ?? '', name: identity?.name ?? '' }
        : { type: 'text' }
    )
  }
})

const done = (reason: string, usage?: Record<string, number>): ScriptedEvent => ({
  type: 'done',
  reason,
  message: {
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage
    }
  }
})

const request = { prompt: 'Write a script about falling', conversationId: 'c1' }
const messages: ChatMessage[] = [{ role: 'user', content: 'Write a script about falling' }]

const collect = async (stream: AsyncGenerator<ProviderFrame, void, unknown>): Promise<ProviderFrame[]> => {
  const frames: ProviderFrame[] = []
  for await (const frame of stream) {
    frames.push(frame)
  }
  return frames
}

type RunOptions = {
  provider?: 'openai' | 'openrouter'
  reasoning?: ReasoningLevel
  abortSignal?: AbortSignal
  messages?: ChatMessage[]
  options?: Parameters<InstanceType<typeof PiAiService>['generateScript']>[4]
}

const run = (events: ScriptedEvent[], runOptions: RunOptions = {}): Promise<ProviderFrame[]> => {
  piAi.state.events = events
  const service = new PiAiService('sk-test', runOptions.provider ?? 'openai', runOptions.reasoning)
  return collect(
    service.generateScript(
      request,
      runOptions.messages ?? messages,
      undefined,
      runOptions.abortSignal,
      runOptions.options
    )
  )
}

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
  piAi.state.events = []
  piAi.state.requests = []
  piAi.state.providers = []
  piAi.state.providerLoadError = null
  clearTranscripts()
  stubTranscriptCapture(false)
  // The adapter logs the outbound request on every call
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PiAiService text frames', () => {
  it('yields firstToken once, then every text delta in order, then usage and finished', async () => {
    const frames = await run([
      textDelta('Once '),
      textDelta('upon '),
      textDelta('a time'),
      done('stop', { input: 132, output: 120, cacheRead: 768 })
    ])

    expect(frames).toEqual([
      { kind: 'firstToken', at: expect.any(Number) },
      { kind: 'text', delta: 'Once ' },
      { kind: 'text', delta: 'upon ' },
      { kind: 'text', delta: 'a time' },
      { kind: 'usage', promptTokens: 900, completionTokens: 120, cachedTokens: 768 },
      { kind: 'finished', reason: 'stop' }
    ])
  })

  it('emits nothing after the done event', async () => {
    const frames = await run([textDelta('body'), done('stop'), textDelta('never sent')])

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', delta: 'body' }])
  })
})

describe('PiAiService thinking', () => {
  it('reports reasoning as its own frame, in order, without touching the body', async () => {
    const frames = await run([
      thinkingDelta('Let me plan '),
      thinkingDelta('the induction.'),
      textDelta('Breathe in'),
      done('stop')
    ])

    expect(frames.filter(frame => frame.kind === 'thinking')).toEqual([
      { kind: 'thinking', delta: 'Let me plan ' },
      { kind: 'thinking', delta: 'the induction.' }
    ])
    expect(frames.filter(frame => frame.kind === 'text')).toEqual([
      { kind: 'text', delta: 'Breathe in' }
    ])
  })

  // The whole reason the frame exists: this is the shape of a real reasoning
  // run, where the model says nothing else for a long time and then emits the
  // section in one burst.
  it('reports reasoning before any output has arrived', async () => {
    const frames = await run([thinkingDelta('thinking hard'), done('stop')])

    expect(frames[0]).toEqual({ kind: 'thinking', delta: 'thinking hard' })
  })

  // firstToken feeds the time-to-first-token metric, which is compared against
  // the SDK path — and that path never sees reasoning at all, because
  // `delta.reasoning` is not a field it reads. Counting reasoning here would
  // make the two engines' numbers mean different things.
  it('does not count reasoning as the first token', async () => {
    const frames = await run([
      thinkingDelta('still thinking'),
      textDelta('first real output'),
      done('stop')
    ])

    const kinds = frames.map(frame => frame.kind)
    expect(kinds.indexOf('firstToken')).toBeGreaterThan(kinds.indexOf('thinking'))
    expect(frames[kinds.indexOf('firstToken') + 1]).toEqual({ kind: 'text', delta: 'first real output' })
  })
})

describe('PiAiService tool calls', () => {
  it('carries id and name on every frame though the block names them once', async () => {
    const frames = await run([
      toolDelta(0, '{"title":', { id: 'call_abc', name: 'section_write' }),
      toolDelta(0, '"Opening"'),
      toolDelta(0, '}'),
      done('toolUse')
    ])

    expect(frames.filter(frame => frame.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', index: 0, id: 'call_abc', name: 'section_write', argumentsDelta: '{"title":' },
      { kind: 'toolCall', index: 0, id: 'call_abc', name: 'section_write', argumentsDelta: '"Opening"' },
      { kind: 'toolCall', index: 0, id: 'call_abc', name: 'section_write', argumentsDelta: '}' }
    ])
  })

  it('emits firstToken on a tool-call delta when no text precedes it', async () => {
    const frames = await run([
      toolDelta(0, '{', { id: 'call_a', name: 'outline_write' }),
      done('toolUse')
    ])

    expect(frames[0]).toEqual({ kind: 'firstToken', at: expect.any(Number) })
    expect(frames[1].kind).toBe('toolCall')
  })

  it('concatenates the fragments into the JSON document the orchestrator expects', async () => {
    const fragments = ['{', '"title"', ':', '"Opening"', '}']
    const frames = await run([
      ...fragments.map((fragment, index) =>
        toolDelta(0, fragment, index === 0 ? { id: 'call_a', name: 'section_write' } : undefined)
      ),
      done('toolUse')
    ])
    const calls = frames.filter(frame => frame.kind === 'toolCall')

    // One frame per delta, no buffering: the accumulated string has to stay a
    // character-by-character prefix of the final JSON while it arrives.
    expect(calls).toHaveLength(fragments.length)
    expect(calls.map(call => call.argumentsDelta)).toEqual(fragments)
    expect(JSON.parse(calls.map(call => call.argumentsDelta).join(''))).toEqual({ title: 'Opening' })
  })

  it('keeps two calls apart by content index', async () => {
    const frames = await run([
      toolDelta(1, '{"a":', { id: 'call_a', name: 'section_write' }),
      toolDelta(2, '{"b":', { id: 'call_b', name: 'section_revise' }),
      toolDelta(1, '1}'),
      toolDelta(2, '2}'),
      done('toolUse')
    ])
    const calls = frames.filter(frame => frame.kind === 'toolCall')

    expect(calls.map(call => [call.index, call.id, call.name, call.argumentsDelta])).toEqual([
      [1, 'call_a', 'section_write', '{"a":'],
      [2, 'call_b', 'section_revise', '{"b":'],
      [1, 'call_a', 'section_write', '1}'],
      [2, 'call_b', 'section_revise', '2}']
    ])
  })

  it('remembers the identity from a later delta when the first arrives without one', async () => {
    // The completions adapter can send a delta or two before the provider has
    // named the call it is filling in.
    const frames = await run([
      toolDelta(0, '{'),
      toolDelta(0, '"title"', { id: 'call_late', name: 'section_write' }),
      toolDelta(0, ':1}'),
      done('toolUse')
    ])
    const calls = frames.filter(frame => frame.kind === 'toolCall')

    expect(calls.map(call => call.id)).toEqual(['pi-call-0', 'call_late', 'call_late'])
    expect(calls.map(call => call.name)).toEqual(['', 'section_write', 'section_write'])
  })

  it('never yields a blank id, since a blank one would never stick downstream', async () => {
    const frames = await run([toolDelta(0, '{}'), done('toolUse')])

    expect(frames.filter(frame => frame.kind === 'toolCall').map(call => call.id)).toEqual(['pi-call-0'])
  })
})

describe('PiAiService finish reasons', () => {
  // The orchestrator compares against OpenAI's vocabulary: only 'stop' and
  // 'tool_calls' count as a cleanly finished stream, and only 'length' marks a
  // section as possibly cut off.
  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['toolUse', 'tool_calls'],
    ['deferred', 'deferred']
  ])('reports pi-ai %s as %s', async (reason, expected) => {
    const frames = await run([textDelta('body'), done(reason)])

    expect(frames.filter(frame => frame.kind === 'finished')).toEqual([
      { kind: 'finished', reason: expected }
    ])
  })
})

describe('PiAiService usage', () => {
  it('adds the cached tokens back into the prompt count so both engines compare', async () => {
    // pi-ai reports input with the cached tokens taken out; OpenAI's
    // prompt_tokens counts them in.
    const frames = await run([done('stop', { input: 100, output: 20, cacheRead: 700, cacheWrite: 100 })])

    expect(frames.filter(frame => frame.kind === 'usage')).toEqual([
      { kind: 'usage', promptTokens: 900, completionTokens: 20, cachedTokens: 700 }
    ])
  })
})

describe('PiAiService abort and failure', () => {
  it('returns cleanly on an aborted stream and keeps the frames that preceded it', async () => {
    const controller = new AbortController()
    controller.abort()
    const frames = await run(
      [textDelta('kept one '), textDelta('kept two'), { type: 'error', reason: 'aborted', error: {} }],
      { abortSignal: controller.signal }
    )

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([
      { kind: 'text', delta: 'kept one ' },
      { kind: 'text', delta: 'kept two' }
    ])
    expect(frames.some(frame => frame.kind === 'finished')).toBe(false)
  })

  it('returns cleanly when pi-ai reports the abort though the signal was never handed over', async () => {
    const frames = await run([textDelta('kept'), { type: 'error', reason: 'aborted', error: {} }])

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', delta: 'kept' }])
  })

  it('returns cleanly when the signal fired but pi-ai called the failure an error', async () => {
    // The adapters only report reason 'aborted' when they notice the signal
    // themselves; a transport that dies as the request is cancelled arrives as
    // an ordinary error, and the user stopping a run is still not a failure.
    const controller = new AbortController()
    controller.abort()
    const frames = await run(
      [textDelta('kept'), { type: 'error', reason: 'error', error: { errorMessage: 'terminated' } }],
      { abortSignal: controller.signal }
    )

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', delta: 'kept' }])
  })

  it('throws the message off an error event', async () => {
    await expect(
      run([textDelta('partial'), { type: 'error', reason: 'error', error: { errorMessage: 'provider exploded' } }])
    ).rejects.toThrow('provider exploded')
  })

  it('throws even when an abort signal exists but never fired', async () => {
    const controller = new AbortController()
    await expect(
      run([{ type: 'error', reason: 'error', error: { errorMessage: 'rate limited' } }], {
        abortSignal: controller.signal
      })
    ).rejects.toThrow('rate limited')
  })

  it('throws something readable when the failure carries no message', async () => {
    await expect(run([{ type: 'error', reason: 'error', error: {} }])).rejects.toThrow(
      'The provider stream failed.'
    )
  })
})

describe('PiAiService request', () => {
  it('loads only the provider in use and sends the key and signal with the request', async () => {
    const controller = new AbortController()
    await run([done('stop')], { provider: 'openrouter', abortSignal: controller.signal })

    expect(piAi.state.providers).toEqual(['openrouter'])
    expect(piAi.state.requests[0].options).toMatchObject({
      apiKey: 'sk-test',
      signal: controller.signal
    })
  })

  it('describes an openai model against the responses api and an openrouter one against completions', async () => {
    await run([done('stop')])
    await run([done('stop')], { provider: 'openrouter' })

    expect(piAi.state.requests.map(sent => [sent.model.provider, sent.model.api, sent.model.baseUrl])).toEqual([
      ['openai', 'openai-responses', 'https://api.openai.com/v1'],
      ['openrouter', 'openai-completions', 'https://openrouter.ai/api/v1']
    ])
    // Settings accept any model id, so the adapter describes the model itself
    expect(piAi.state.requests[0].model.id).toBe('gpt-5')
  })

  it('lifts every system turn out of the history and onto the context', async () => {
    await run([done('stop')], {
      messages: [
        { role: 'system', content: 'You write hypnosis scripts' },
        { role: 'user', content: 'A script about falling' },
        { role: 'assistant', content: 'Here it is' },
        { role: 'system', content: 'Keep it short' }
      ]
    })
    const sent = piAi.state.requests[0].context

    expect(sent.systemPrompt).toBe('You write hypnosis scripts\n\nKeep it short')
    expect(sent.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('builds its own system prompt only when the caller supplies no messages', async () => {
    piAi.state.events = [done('stop')]
    const service = new PiAiService('sk-test', 'openai')
    await collect(service.generateScript(request, []))
    const sent = piAi.state.requests[0].context

    expect(sent.systemPrompt).toBeTruthy()
    expect(sent.messages).toEqual([
      { role: 'user', content: 'Write a script about falling', timestamp: expect.any(Number) }
    ])
  })

  it('unwraps the tool specs and attaches them only when there are some', async () => {
    await run([done('stop')], {
      options: {
        tools: [
          {
            type: 'function',
            function: {
              name: 'section_write',
              description: 'Write one section',
              parameters: { type: 'object', properties: { title: { type: 'string' } } }
            }
          }
        ]
      }
    })
    await run([done('stop')], { options: { tools: [] } })

    expect(piAi.state.requests[0].context.tools).toEqual([
      {
        name: 'section_write',
        description: 'Write one section',
        parameters: { type: 'object', properties: { title: { type: 'string' } } }
      }
    ])
    expect(piAi.state.requests[1].context.tools).toBeUndefined()
  })

  it('replays a tool exchange after the stored history, naming the tool a result answers', async () => {
    await run([done('stop')], {
      options: {
        toolTurns: [
          {
            role: 'assistant',
            content: 'writing it now',
            toolCalls: [{ id: 'call_a', name: 'section_write', arguments: '{"title":"Opening"}' }]
          },
          { role: 'tool', toolCallId: 'call_a', content: 'ok' }
        ]
      }
    })
    const sent = piAi.state.requests[0].context.messages

    expect(sent.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult'])
    expect(sent[1]).toMatchObject({
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'writing it now' },
        // pi-ai wants the arguments parsed, not the raw JSON text we store
        { type: 'toolCall', id: 'call_a', name: 'section_write', arguments: { title: 'Opening' } }
      ]
    })
    expect(sent[2]).toMatchObject({
      toolCallId: 'call_a',
      toolName: 'section_write',
      content: [{ type: 'text', text: 'ok' }],
      isError: false
    })
  })

  it('replays a malformed tool call as empty arguments rather than failing the whole request', async () => {
    // The half-written call is exactly the case the orchestrator's
    // incomplete-call handling exists for; it must not take the retry down too.
    await run([done('stop')], {
      options: {
        toolTurns: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_a', name: 'section_write', arguments: '{"title":"Ope' }]
          },
          { role: 'tool', toolCallId: 'call_a', content: 'that call was cut off' }
        ]
      }
    })

    expect(piAi.state.requests[0].context.messages[1]).toMatchObject({
      content: [{ type: 'toolCall', id: 'call_a', name: 'section_write', arguments: {} }]
    })
  })
})

describe('PiAiService transcript recording', () => {
  beforeEach(() => {
    stubTranscriptCapture(true)
  })

  it('records the request as readable text, the reply and a complete status', async () => {
    await run(
      [textDelta('Once '), textDelta('upon a time'), done('stop', { input: 10, output: 4 })],
      {
        messages: [
          { role: 'system', content: 'You write hypnosis scripts' },
          { role: 'user', content: 'A script about falling' }
        ]
      }
    )

    const entries = getTranscripts()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      label: 'Generation',
      // Recorded so a transcript says which engine wrote it
      params: { engine: 'pi', api: 'openai-responses' },
      response: 'Once upon a time',
      status: 'complete'
    })
    // The system prompt lives on the context, not in the messages, so it is put
    // back for the transcript; blocks are flattened rather than serialised.
    expect(entries[0].messages).toEqual([
      { role: 'system', content: 'You write hypnosis scripts' },
      { role: 'user', content: 'A script about falling' }
    ])
    expect(entries[0].usage).toEqual({ promptTokens: 10, completionTokens: 4, cachedTokens: 0 })
  })

  it('records tool-call arguments separately from the reply text', async () => {
    await run([
      textDelta('prose only'),
      toolDelta(1, '{"title":', { id: 'call_a', name: 'section_write' }),
      toolDelta(1, '"Opening"}'),
      done('toolUse')
    ])

    const entry = getTranscripts()[0]
    expect(entry.response).toBe('prose only')
    expect(entry.toolCalls).toEqual([
      { index: 1, name: 'section_write', arguments: '{"title":"Opening"}' }
    ])
    expect(entry.status).toBe('complete')
  })

  it('marks the transcript aborted, keeping what streamed before the abort', async () => {
    const controller = new AbortController()
    controller.abort()
    await run([textDelta('kept'), { type: 'error', reason: 'aborted', error: {} }], {
      abortSignal: controller.signal
    })

    expect(getTranscripts()[0]).toMatchObject({ response: 'kept', status: 'aborted' })
  })

  it('marks the transcript failed and records the error message', async () => {
    await expect(
      run([textDelta('partial'), { type: 'error', reason: 'error', error: { errorMessage: 'provider exploded' } }])
    ).rejects.toThrow('provider exploded')

    expect(getTranscripts()[0]).toMatchObject({
      response: 'partial',
      status: 'error',
      error: 'provider exploded'
    })
  })
})

describe('PiAiService regenerateSection', () => {
  it('labels the transcript with the section and sends the history as given', async () => {
    stubTranscriptCapture(true)
    piAi.state.events = [textDelta('rewritten'), done('stop')]
    const service = new PiAiService('sk-test', 'openai')

    const frames = await collect(
      service.regenerateSection(
        { prompt: 'rewrite', conversationId: 'c1', sectionTitle: 'Induction' },
        [
          { role: 'system', content: 'You write hypnosis scripts' },
          { role: 'user', content: 'Rewrite the induction' }
        ]
      )
    )

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', delta: 'rewritten' }])
    expect(getTranscripts()[0]).toMatchObject({ label: 'Induction' })
    expect(piAi.state.requests[0].context.systemPrompt).toBe('You write hypnosis scripts')
  })
})

// pi-ai reports a finish it has no normalised name for as a terminal error
// carrying the provider's own word for it, with the turn's usage attached.
const finishReasonError = (reason: string, usage?: Record<string, number>): ScriptedEvent => ({
  type: 'error',
  reason: 'error',
  error: {
    errorMessage: `Provider finish_reason: ${reason}`,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage }
  }
})

describe('PiAiService provider finish reasons', () => {
  // pi-ai has no normalised name for these, so its adapters report them as a
  // terminal error. They are not failed requests: the response arrived and
  // simply did not end cleanly, which is what the SDK engine reports and what
  // the orchestrator retries a section on.
  it.each(['content_filter', 'network_error', 'some_gateway_word'])(
    'reports finish_reason %s as a finish rather than throwing',
    async (reason) => {
      const frames = await run([
        textDelta('most of a section'),
        finishReasonError(reason)
      ])

      expect(frames.filter(frame => frame.kind === 'text')).toEqual([
        { kind: 'text', delta: 'most of a section' }
      ])
      expect(frames.filter(frame => frame.kind === 'finished')).toEqual([
        { kind: 'finished', reason }
      ])
    }
  )

  it('keeps the tool-call arguments that streamed before an unclean finish', async () => {
    const frames = await run([
      toolDelta(0, '{"title":"Opening"', { id: 'call_a', name: 'section_write' }),
      finishReasonError('content_filter')
    ])

    expect(frames.filter(frame => frame.kind === 'toolCall')).toHaveLength(1)
    expect(frames.at(-1)).toEqual({ kind: 'finished', reason: 'content_filter' })
  })

  it('reports the tokens the unclean turn used, and none when it reports none', async () => {
    const withUsage = await run([
      finishReasonError('content_filter', { input: 100, output: 20, cacheRead: 700, cacheWrite: 100 })
    ])
    const withoutUsage = await run([
      finishReasonError('content_filter')
    ])

    expect(withUsage.filter(frame => frame.kind === 'usage')).toEqual([
      { kind: 'usage', promptTokens: 900, completionTokens: 20, cachedTokens: 700 }
    ])
    // A zero usage frame would read downstream as a turn that cost nothing
    expect(withoutUsage.filter(frame => frame.kind === 'usage')).toEqual([])
  })

  it('still throws on a failure that is not a finish_reason at all', async () => {
    await expect(
      run([{ type: 'error', reason: 'error', error: { errorMessage: 'rate limited' } }])
    ).rejects.toThrow('rate limited')
  })
})

describe('PiAiService replayed tool turns', () => {
  // pi-ai replays a turn verbatim when it matches the model being called,
  // including the provider's own item id. On the responses api that id is only
  // valid beside the reasoning item it was issued with, which a replayed turn
  // of ours cannot carry, so the turn is described as one pi-ai did not
  // produce and pi-ai rewrites the id itself.
  it('never claims the replayed turn came from the model about to be called', async () => {
    await run([done('stop')], {
      options: {
        toolTurns: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_abc|fc_xyz', name: 'section_write', arguments: '{}' }]
          },
          { role: 'tool', toolCallId: 'call_abc|fc_xyz', content: 'too short' }
        ]
      }
    })
    const sent = piAi.state.requests[0].context.messages[1]

    expect(piAi.state.requests[0].model.api).toBe('openai-responses')
    expect(sent).toMatchObject({ api: 'openai-completions', provider: 'openai', model: '' })
  })
})

describe('PiAiService transcript on a failed connect', () => {
  it('opens no transcript when the provider adapter cannot be loaded', async () => {
    stubTranscriptCapture(true)
    piAi.state.providerLoadError = 'Failed to fetch dynamically imported module'

    await expect(run([done('stop')])).rejects.toThrow('Failed to fetch dynamically imported module')

    // An entry opened before the load would sit at 'streaming' forever
    expect(getTranscripts()).toEqual([])
  })
})

describe('DeferredPiAiService', () => {
  it('loads the engine on first use and passes the frames straight through', async () => {
    const { DeferredPiAiService } = await import('../piAiLoader')
    piAi.state.events = [textDelta('deferred'), done('stop')]
    const service = new DeferredPiAiService('sk-test', 'openrouter')

    const frames = await collect(service.generateScript(request, messages))

    expect(piAi.state.providers).toEqual(['openrouter'])
    expect(frames.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', delta: 'deferred' }])
    expect(frames.at(-1)).toEqual({ kind: 'finished', reason: 'stop' })
  })

  it('carries a section regeneration through as well', async () => {
    const { DeferredPiAiService } = await import('../piAiLoader')
    piAi.state.events = [textDelta('rewritten'), done('stop')]
    const service = new DeferredPiAiService('sk-test', 'openai')

    const frames = await collect(
      service.regenerateSection(
        { prompt: 'rewrite', conversationId: 'c1', sectionTitle: 'Induction' },
        [{ role: 'user', content: 'Rewrite the induction' }]
      )
    )

    expect(frames.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', delta: 'rewritten' }])
  })
})


// The setting exists because pi-ai's OpenRouter branch reads BOTH the model's
// `reasoning` flag and the request's effort, and the two combine in a way that
// is easy to get backwards: declaring a model capable of reasoning but naming
// no effort is how pi-ai is told to switch reasoning OFF.
describe('PiAiService reasoning setting', () => {
  it('sends nothing at all by default, so a run is what it always was', async () => {
    await run([done('stop')], { provider: 'openrouter' })

    expect(piAi.state.requests[0].model.reasoning).toBe(false)
    expect(piAi.state.requests[0].options?.reasoningEffort).toBeUndefined()
  })

  it('asks for the named level', async () => {
    await run([done('stop')], { provider: 'openrouter', reasoning: 'high' })

    expect(piAi.state.requests[0].model.reasoning).toBe(true)
    expect(piAi.state.requests[0].options?.reasoningEffort).toBe('high')
  })

  // The one that would silently do the opposite of what it says if the flag and
  // the effort were wired together
  it('switches reasoning off by declaring the model capable and naming no effort', async () => {
    await run([done('stop')], { provider: 'openrouter', reasoning: 'off' })

    expect(piAi.state.requests[0].model.reasoning).toBe(true)
    expect(piAi.state.requests[0].options?.reasoningEffort).toBeUndefined()
  })
})
