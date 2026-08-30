import OpenAI from 'openai'
import type { ProviderFrame } from './providerFrame'
import { beginTranscript, toTranscriptMessages, NO_TRANSCRIPT } from './debugTranscript'
import type { TranscriptRecorder } from './debugTranscript'

// The one streaming loop, shared by every OpenAI-compatible provider. It used
// to be copied per service, and the copies had already drifted: OpenRouter had
// lost the cache key, the temperature and the usage handling, and began its
// transcript outside the try. Tool calls make a second copy actively
// dangerous — reassembling argument fragments is fiddly enough once — so the
// loop lives here and each service supplies only what genuinely differs: its
// client, its label, and the payload fields it wants added.

export interface OpenAiCompatibleStreamOptions {
  client: OpenAI
  // Names the provider in the debug transcript and in the console
  provider: string
  model: string
  messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>
  // Payload fields beyond model/messages/stream: temperature, prompt_cache_key,
  // tools, and whatever a provider needs next. Typed against the streaming
  // create params so the compiler checks them.
  extras?: Partial<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming>
  abortSignal?: AbortSignal
  // What the request was for: 'Generation', a section title, 'Refinement', ...
  label: string
  exampleIds?: string[]
  // Recorded alongside the messages so a transcript shows how the request was
  // parameterised, not just what it said
  transcriptParams?: Record<string, unknown>
}

export async function* streamOpenAiCompatible(
  options: OpenAiCompatibleStreamOptions
): AsyncGenerator<ProviderFrame, void, unknown> {
  const { client, provider, model, messages, extras, abortSignal, label } = options

  let transcript: TranscriptRecorder = NO_TRANSCRIPT

  try {
    const payload: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model,
      messages,
      stream: true,
      // Absent until now, which is why the cached-token reporting below never
      // fired: without it the provider sends no usage block on a stream at all
      stream_options: { include_usage: true },
      ...extras
    }

    const requestOptions = abortSignal ? { signal: abortSignal } : {}

    console.debug(`${provider} chat completions request:`, {
      ...payload,
      systemMessageLength: messages.find(message => message.role === 'system')?.content?.length ?? 0,
      totalMessages: messages.length,
      hasAbortSignal: !!abortSignal
    })

    // Records exactly what goes to the provider, examples and all, when the
    // debug transcript option is on
    transcript = beginTranscript({
      provider,
      model,
      label,
      exampleIds: options.exampleIds,
      messages: toTranscriptMessages(messages),
      params: options.transcriptParams
    })

    const response = await client.chat.completions.create(payload, requestOptions)

    // A tool call's id and name arrive only with the first fragment of its
    // arguments; every later fragment carries the index alone. Remembering
    // them per index is what lets each emitted frame name the call it belongs
    // to. Keyed on index and never on id, because on most deltas there is no
    // id to key on.
    const callIdentities = new Map<number, { id?: string; name?: string }>()
    let sawFirstToken = false

    for await (const chunk of response) {
      const choice = chunk.choices[0]
      const delta = choice?.delta

      const text = delta?.content
      if (text) {
        if (!sawFirstToken) {
          sawFirstToken = true
          yield { kind: 'firstToken', at: Date.now() }
        }
        transcript.appendChunk(text)
        yield { kind: 'text', delta: text }
      }

      for (const call of delta?.tool_calls ?? []) {
        if (!sawFirstToken) {
          sawFirstToken = true
          yield { kind: 'firstToken', at: Date.now() }
        }
        const known = callIdentities.get(call.index) ?? {}
        const identity = {
          id: call.id ?? known.id,
          name: call.function?.name ?? known.name
        }
        callIdentities.set(call.index, identity)

        const argumentsDelta = call.function?.arguments ?? ''
        transcript.appendToolCallDelta(call.index, identity.name, argumentsDelta)
        // Passed straight through rather than buffered to a complete call, so
        // a caller can render arguments as they arrive
        yield {
          kind: 'toolCall',
          index: call.index,
          id: identity.id,
          name: identity.name,
          argumentsDelta
        }
      }

      if (choice?.finish_reason) {
        yield { kind: 'finished', reason: choice.finish_reason }
      }

      // The usage block rides on its own final chunk, after the choices are
      // done, so it is read outside the delta handling above
      if (chunk.usage) {
        const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens
        if (cachedTokens !== undefined) {
          const promptTokens = chunk.usage.prompt_tokens || 0
          const hitRate = promptTokens ? (cachedTokens / promptTokens * 100).toFixed(1) : '0'
          console.debug('Prompt cache performance:', {
            provider,
            promptCacheKey: extras?.prompt_cache_key,
            promptTokens,
            cachedTokens,
            cacheHitRate: `${hitRate}%`
          })
        }
        const usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          cachedTokens
        }
        transcript.recordUsage(usage)
        yield { kind: 'usage', ...usage }
      }
    }

    transcript.complete()
  } catch (error) {
    // An abort is the user stopping a run, not a failure: the caller keeps
    // whatever streamed before it, so the generator returns cleanly rather
    // than throwing an error every call site would have to special-case.
    if (abortSignal?.aborted) {
      transcript.abort()
      console.debug(`${provider} generation aborted by user`)
      return
    }
    transcript.fail(error)
    console.error(`${provider} generation error:`, error)
    throw error
  }
}
