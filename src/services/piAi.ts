import { createModels } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  MutableModels,
  TSchema,
  Tool,
  ToolCall,
  Usage
} from '@earendil-works/pi-ai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import { buildGenerationSystemPrompt } from './prompts'
import type { ExampleScript } from './exampleSearchService'
import type {
  ScriptGenerationService,
  ProviderCallOptions,
  ProviderTurn
} from './scriptGenerationService'
import { getModel, type ReasoningLevel } from './config'
import { buildLengthPlan } from './scriptLength'
import { exampleIdsOf, beginTranscript, toTranscriptMessages, NO_TRANSCRIPT } from './debugTranscript'
import type { TranscriptContext, TranscriptRecorder } from './debugTranscript'
import type { ProviderFrame } from './providerFrame'
import type { LiveProvider } from './providerStatus'

// The second engine, run side by side with the OpenAI SDK path rather than in
// place of it. Same provider, same key, same model id — only the client
// library underneath differs, so a run can be repeated on both engines and the
// two outputs compared. Nothing here is reachable unless the llmEngine setting
// says 'pi'; with the default 'sdk' the request still goes through
// openAiCompatibleStream.ts exactly as it always did.
//
// The shape of this class deliberately mirrors OpenAIService/OpenRouterService:
// the same two entry points, the same decision about when to build a system
// prompt of its own, the same appending of a replayed tool exchange at send
// time. What differs is everything below the message list, because pi-ai does
// not speak OpenAI's wire shapes.

// A pi-ai AssistantMessage is a whole response record, so replaying one from
// our stored history means filling in fields that only a real response has.
// The usage of a turn we are merely quoting back is zero by definition: it was
// paid for when the turn was first generated, and pi-ai only reads this field
// to accumulate totals we do not display.
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

// pi-ai reports a normalised stop reason rather than the provider's own
// finish_reason, and the orchestrator compares against the OpenAI vocabulary:
// rawScriptGenerationOrchestrator only counts a stream as cleanly finished when
// the reason is 'stop' or 'tool_calls', and scriptProjection only flags a
// section as possibly cut off when it is exactly 'length'. So 'toolUse' has to
// arrive here as 'tool_calls' or every tool-written section would look
// truncated and be rewritten, and 'length' has to survive verbatim or a
// genuinely truncated section would never be redone on resume. 'deferred'
// passes through under its own name: nothing in this app asks for a deferred
// response, and mapping it onto one of the two "clean" reasons would be a lie
// that reads as a finished section.
const FINISH_REASONS: Record<'stop' | 'length' | 'toolUse' | 'deferred', string> = {
  stop: 'stop',
  length: 'length',
  toolUse: 'tool_calls',
  deferred: 'deferred'
}

// pi-ai has no normalised name for a finish_reason outside its own small set —
// 'content_filter' and whatever a gateway invents among them — so its adapters
// report one as a terminal error carrying this prefix rather than as a finish.
// The SDK path reports the same finishes as an ordinary `finished` frame with
// the provider's word on it, and the orchestrator answers that by keeping what
// streamed and retrying the section. Turning it back into a finish here is what
// keeps the two engines comparable: a filtered section is retried on both
// instead of killing the run on one.
const PROVIDER_FINISH_PREFIX = 'Provider finish_reason: '

function uncleanFinishReason(errorMessage: string | undefined): string | undefined {
  return errorMessage?.startsWith(PROVIDER_FINISH_PREFIX)
    ? errorMessage.slice(PROVIDER_FINISH_PREFIX.length)
    : undefined
}

// pi-ai reports input tokens with the cached ones taken out, where OpenAI's
// prompt_tokens counts them in. They are added back so the cost line reads the
// same on both engines for the same run.
function usageFrom(usage: Usage): { promptTokens: number; completionTokens: number; cachedTokens: number } {
  return {
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage.output,
    cachedTokens: usage.cacheRead
  }
}

// Settings accept any model id the user cares to type, and pi-ai's catalog
// lookup is a static table, so getModel() answers undefined for anything it has
// not heard of — including every model released since this version of the
// package was cut. Rather than refuse those, we describe the model ourselves.
//
// Nothing is lost by always doing so, and one thing is gained: a catalog hit
// and a made-up entry then behave identically, which is the only way a
// prototype meant for comparison is worth anything. The fields pi-ai actually
// puts on the wire come from the request options, not from here — maxTokens is
// only an overflow-estimation ceiling and contextWindow is advisory — and the
// zeroed costs simply make pi-ai's cost accounting report zero, which is fine
// because instascript prices runs from its own table.
//
// The api must match what the provider can actually dispatch. The OpenAI
// provider is built with a single Responses implementation and ignores
// model.api entirely, so every OpenAI request on this engine goes to
// /v1/responses while the SDK path goes to /v1/chat/completions. That is a real
// difference in what the provider sees, accepted here because the alternative
// is registering a custom provider to force the completions adapter, which is
// more machinery than a side-by-side prototype needs. OpenRouter dispatches on
// model.api through a map, and 'openai-completions' is the entry that matches
// what the SDK path sends it.
// `reasoning` is what decides whether pi-ai sends a reasoning parameter at all.
// Left false, it sends none and the provider does whatever it does by default —
// which is every run this app made before the setting existed. Set true, pi-ai
// takes charge: with an effort it asks for that level, and WITHOUT one it sends
// `{ effort: 'none' }`, which switches reasoning off rather than leaving it
// alone. That asymmetry is why 'provider' and 'off' are separate settings here
// and not one tri-state.
function describeModel(provider: LiveProvider, modelId: string, reasoning: boolean): Model<Api> {
  return provider === 'openrouter'
    ? {
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        reasoning,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32768
      }
    : {
        id: modelId,
        name: modelId,
        api: 'openai-responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        reasoning,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32768
      }
}

// pi-ai has no system role in its message union: the system prompt is a field
// on the request context. Our stored history keeps it as an ordinary message,
// and a caller may have appended a second one mid-conversation, so every system
// turn is lifted out and joined in the order it was written. The rest map
// across unchanged, which is the same "role and content, nothing else"
// conversion the SDK services do.
function splitSystemPrompt(messages: ChatMessage[]): { systemPrompt?: string; rest: Message[] } {
  const system = messages.filter(message => message.role === 'system').map(message => message.content)
  const rest: Message[] = messages
    .filter(message => message.role !== 'system')
    .map(message =>
      message.role === 'assistant'
        ? assistantRecord([{ type: 'text', text: message.content }], 'stop')
        : { role: 'user' as const, content: message.content, timestamp: Date.now() }
    )
  return { ...(system.length > 0 && { systemPrompt: system.join('\n\n') }), rest }
}

// The fields pi-ai requires on any assistant turn, real or replayed. We only
// ever build turns we are quoting back, never ones pi-ai produced, and that
// distinction is the whole point of these three fields.
//
// pi-ai compares a replayed turn's provider/api/model against the model it is
// about to call, and treats a match as "this came from me, replay it
// verbatim". That is only safe for a record pi-ai itself returned, complete
// with the reasoning block it pairs with a tool call: on the Responses api
// OpenAI validates that a replayed fc_ item id arrives beside the rs_
// reasoning item it was issued with, and our ProviderTurn cannot carry one, so
// claiming to be the live model would have the raw fc_ id replayed and the
// request rejected outright. Describing the record as foreign instead makes
// pi-ai rewrite the item id to one of its own — the escape hatch it builds for
// cross-provider replay — and the exchange is accepted. The ids stay
// consistent because pi-ai rewrites the matching tool result alongside it.
function assistantRecord(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: '',
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now()
  }
}

// The wire-only tool exchange, in pi-ai's shapes. Two things differ from the
// OpenAI conversion this replaces. Arguments are stored as the raw JSON text
// the model streamed, but pi-ai wants them parsed: a model that emitted
// malformed JSON — the very case the orchestrator's incomplete-call handling
// exists for — must not take the whole request down, so a failed parse replays
// as an empty object. And a tool result has to name the tool it answers, which
// our ToolResultTurn does not carry; the name comes from the assistant turn
// earlier in the same array that made the call, since that is the only place it
// exists.
function toolTurnsToPiAi(turns: ProviderTurn[] | undefined): Message[] {
  const namesByCallId = new Map<string, string>()
  for (const turn of turns ?? []) {
    if (turn.role === 'assistant') {
      for (const call of turn.toolCalls) namesByCallId.set(call.id, call.name)
    }
  }

  return (turns ?? []).map(turn => {
    if (turn.role === 'tool') {
      return {
        role: 'toolResult' as const,
        toolCallId: turn.toolCallId,
        toolName: namesByCallId.get(turn.toolCallId) ?? '',
        content: [{ type: 'text' as const, text: turn.content }],
        isError: false,
        timestamp: Date.now()
      }
    }

    const calls: ToolCall[] = turn.toolCalls.map(call => ({
      type: 'toolCall' as const,
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments)
    }))
    return assistantRecord(
      [...(turn.content ? [{ type: 'text' as const, text: turn.content }] : []), ...calls],
      'toolUse'
    )
  })
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// The one cast in this file, and the reason for it: pi-ai types a tool's
// parameters as TypeBox's TSchema, which is a branded JSON Schema. The schemas
// in writingTools.ts are plain JSON Schema objects — structurally the same
// thing, and forwarded to the provider verbatim by both engines — but they
// carry none of TypeBox's brand symbols, so the compiler cannot see that on its
// own. Kept to this function so nothing else has to know.
function toolsToPiAi(tools: readonly ToolSpecLike[] | undefined): Tool[] {
  return (tools ?? []).map(spec => ({
    name: spec.function.name,
    description: spec.function.description ?? '',
    parameters: (spec.function.parameters ?? { type: 'object', properties: {} }) as unknown as TSchema
  }))
}

type ToolSpecLike = {
  function: { name: string; description?: string; parameters?: unknown }
}

// The transcript stores one string per message, and pi-ai content is an array
// of blocks. Flattening the text blocks here keeps the debug transcript
// readable on both engines rather than showing a wall of serialised JSON for
// every turn, while a tool call still shows as its structure because that is
// what it is.
function flattenForTranscript(
  systemPrompt: string | undefined,
  messages: Message[]
): Array<{ role: string; content?: unknown }> {
  const flattened = messages.map(message => {
    if (message.role === 'user') {
      return {
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : message.content.map(block => (block.type === 'text' ? block.text : '[image]')).join('')
      }
    }
    if (message.role === 'toolResult') {
      return {
        role: message.role,
        content: message.content.map(block => (block.type === 'text' ? block.text : '[image]')).join('')
      }
    }
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const calls = message.content.filter(block => block.type === 'toolCall')
    return { role: message.role, content: calls.length > 0 ? JSON.stringify({ text, calls }) : text }
  })

  return systemPrompt === undefined
    ? flattened
    : [{ role: 'system', content: systemPrompt }, ...flattened]
}

export class PiAiService implements ScriptGenerationService {
  private readonly apiKey: string
  private readonly provider: LiveProvider
  private readonly reasoning: ReasoningLevel

  constructor(apiKey: string, provider: LiveProvider, reasoning: ReasoningLevel = 'provider') {
    this.apiKey = apiKey
    this.provider = provider
    this.reasoning = reasoning
  }

  // Only reached when a caller supplies no messages of its own. The
  // orchestrator always does, and builds this same string itself.
  private buildInstructions(examples?: ExampleScript[], targetMinutes?: number): string {
    return buildGenerationSystemPrompt(buildLengthPlan(targetMinutes), examples ?? [])
  }

  // The provider module is loaded on demand, and only the one provider in use
  // is loaded at all. pi-ai ships an adapter per provider family, and the
  // package's own guidance is to reach for the individual entry points rather
  // than the barrel that pulls in every vendor SDK; a dynamic import keeps that
  // promise while still letting the choice be made from a setting at runtime.
  private async connect(): Promise<MutableModels> {
    const models = createModels()
    if (this.provider === 'openrouter') {
      const { openrouterProvider } = await import('@earendil-works/pi-ai/providers/openrouter')
      models.setProvider(openrouterProvider())
    } else {
      const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai')
      models.setProvider(openaiProvider())
    }
    return models
  }

  async *generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    console.debug('PiAiService.generateScript called', {
      provider: this.provider,
      messagesCount: messages?.length || 0,
      examplesCount: examples?.length || 0
    })

    const prepared = messages && messages.length > 0
      ? splitSystemPrompt(messages)
      : {
          systemPrompt: this.buildInstructions(examples, request.targetMinutes),
          rest: [{ role: 'user' as const, content: request.prompt, timestamp: Date.now() }]
        }

    yield* this.streamCompletion(prepared.systemPrompt, prepared.rest, abortSignal, {
      label: 'Generation',
      exampleIds: exampleIdsOf(examples)
    }, options)
  }

  async *regenerateSection(
    request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    console.debug('PiAiService.regenerateSection called', {
      provider: this.provider,
      messagesCount: messages.length,
      sectionTitle: request.sectionTitle
    })

    const prepared = splitSystemPrompt(messages)
    yield* this.streamCompletion(prepared.systemPrompt, prepared.rest, abortSignal, {
      label: request.sectionTitle || 'Refinement'
    }, options)
  }

  private async *streamCompletion(
    systemPrompt: string | undefined,
    messages: Message[],
    abortSignal: AbortSignal | undefined,
    context: TranscriptContext,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    const modelId = getModel()
    const model = describeModel(this.provider, modelId, this.reasoning !== 'provider')
    const tools = toolsToPiAi(options?.tools)

    const request: Context = {
      ...(systemPrompt !== undefined && { systemPrompt }),
      // The tool exchange rides after the stored history, never inside it: a
      // tool result has to follow the assistant turn that made the call
      messages: [...messages, ...toolTurnsToPiAi(options?.toolTurns)],
      ...(tools.length > 0 && { tools })
    }

    // Connected before the transcript is opened, not after: this is the one
    // awaited call in the method that can reject on its own — it loads the
    // provider adapter over the network — and an entry opened before it would
    // be left at 'streaming' forever in the debug panel when it does.
    const models = await this.connect()

    let transcript: TranscriptRecorder = NO_TRANSCRIPT

    console.debug('pi-ai stream request:', {
      provider: this.provider,
      model: modelId,
      api: model.api,
      systemMessageLength: systemPrompt?.length ?? 0,
      totalMessages: request.messages.length,
      hasAbortSignal: !!abortSignal
    })

    transcript = beginTranscript({
      provider: this.provider,
      model: modelId,
      label: context.label,
      exampleIds: context.exampleIds,
      messages: toTranscriptMessages(flattenForTranscript(systemPrompt, request.messages)),
      // Recorded so a transcript says which engine wrote it, which is the whole
      // point of running the two side by side
      params: { engine: 'pi', api: model.api }
    })

    // A tool call's id and name live on the content block the deltas are
    // filling in, not on the deltas themselves, and on the completions adapter
    // the id can still be empty for the first delta or two. So the identity is
    // re-read and remembered on every delta, keyed on the content index, just
    // as the SDK loop keys on the call index. The arguments on that block are
    // never read: both adapters accumulate the JSON in a private field and
    // leave the public one empty until the call ends.
    const identities = new Map<number, { id: string; name: string }>()
    let sawFirstToken = false

    // Nothing below throws of its own accord. pi-ai wraps request setup —
    // unknown provider, auth resolution, the lazy load of the vendor SDK — and
    // reports every one of those as a terminal error event rather than a
    // rejected promise, so the error case in this switch is the only failure
    // path there is, and a bare try/catch here would see a clean end of stream.
    // 'off' names no effort ON PURPOSE: that is what makes pi-ai send
    // `{ effort: 'none' }` and switch reasoning off. 'provider' never reaches
    // here as a reasoning model at all, so it sends nothing either way.
    const effort = this.reasoning === 'provider' || this.reasoning === 'off'
      ? undefined
      : this.reasoning

    for await (const event of models.stream(model, request, {
      apiKey: this.apiKey,
      ...(effort && { reasoningEffort: effort }),
      ...(abortSignal && { signal: abortSignal })
    })) {
      switch (event.type) {
        case 'text_delta': {
          if (!sawFirstToken) {
            sawFirstToken = true
            yield { kind: 'firstToken', at: Date.now() }
          }
          transcript.appendChunk(event.delta)
          yield { kind: 'text', delta: event.delta }
          break
        }

        // Reasoning, kept out of the script and out of the first-token
        // measurement. It is not output: counting it as the first token would
        // report a time-to-first-token this engine's numbers could no longer be
        // compared with the SDK path's, which never sees reasoning at all
        // because `delta.reasoning` is not a field openAiCompatibleStream reads.
        case 'thinking_delta': {
          yield { kind: 'thinking', delta: event.delta }
          break
        }

        case 'toolcall_delta': {
          if (!sawFirstToken) {
            sawFirstToken = true
            yield { kind: 'firstToken', at: Date.now() }
          }
          const block = event.partial.content[event.contentIndex]
          const known = identities.get(event.contentIndex)
          const identity = {
            // An empty id would never stick downstream — the consumer only
            // takes a truthy one — and the id is replayed verbatim as the
            // tool_call_id, so a call that never gets one from the provider is
            // given a stable name of its own rather than none.
            id: (block?.type === 'toolCall' && block.id) || known?.id || `pi-call-${event.contentIndex}`,
            name: (block?.type === 'toolCall' && block.name) || known?.name || ''
          }
          identities.set(event.contentIndex, identity)

          transcript.appendToolCallDelta(event.contentIndex, identity.name, event.delta)
          // Passed straight through rather than buffered: the accumulated
          // string has to stay a character-by-character prefix of the final
          // JSON, because the section body is rendered from partial scans of it
          // while it arrives
          yield {
            kind: 'toolCall',
            index: event.contentIndex,
            id: identity.id,
            name: identity.name,
            argumentsDelta: event.delta
          }
          break
        }

        case 'done': {
          const usage = usageFrom(event.message.usage)
          transcript.recordUsage(usage)
          yield { kind: 'usage', ...usage }
          yield { kind: 'finished', reason: FINISH_REASONS[event.reason] }
          transcript.complete()
          return
        }

        case 'error': {
          // An abort is the user stopping a run, not a failure: the caller
          // keeps whatever streamed before it, so the generator returns cleanly
          // rather than throwing an error every call site would have to
          // special-case.
          if (abortSignal?.aborted || event.reason === 'aborted') {
            transcript.abort()
            console.debug('pi-ai generation aborted by user')
            return
          }
          // A finish the provider named and pi-ai has no word for is not a
          // failed request: the response arrived, it simply did not end
          // cleanly. Reported as the finish it is, so the caller keeps the
          // streamed section and retries it exactly as it does on the SDK
          // engine, rather than the whole run dying on a single filtered
          // section.
          const unclean = uncleanFinishReason(event.error.errorMessage)
          if (unclean !== undefined) {
            const usage = usageFrom(event.error.usage)
            // Zeroed when the failure came before the provider's usage block;
            // a zero usage frame would read as a free turn downstream.
            if (usage.promptTokens > 0 || usage.completionTokens > 0) {
              transcript.recordUsage(usage)
              yield { kind: 'usage', ...usage }
            }
            yield { kind: 'finished', reason: unclean }
            transcript.complete()
            console.debug('pi-ai stream ended on provider finish_reason:', unclean)
            return
          }
          // The event carries an assistant message describing the failure, not
          // an Error, and callers up the stack expect an Error.
          const message = event.error.errorMessage ?? 'The provider stream failed.'
          transcript.fail(message)
          console.error('pi-ai generation error:', message)
          throw new Error(message)
        }
      }
    }

    // Reached only if the stream ended without either terminal event, which the
    // protocol says cannot happen. Closing the transcript anyway keeps a
    // half-written entry from sitting in the panel forever.
    transcript.complete()
  }
}
