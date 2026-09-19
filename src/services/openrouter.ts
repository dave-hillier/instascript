import OpenAI from 'openai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import { buildGenerationSystemPrompt } from './prompts'
import type { ScriptGenerationService, ProviderCallOptions } from './scriptGenerationService'
import { toolTurnsToOpenAI } from './scriptGenerationService'
import { getModel } from './config'
import { buildLengthPlan } from './scriptLength'
import { exampleIdsOf } from './debugTranscript'
import type { TranscriptContext } from './debugTranscript'
import { streamOpenAiCompatible } from './openAiCompatibleStream'
import type { ProviderFrame } from './providerFrame'

export class OpenRouterService implements ScriptGenerationService {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      dangerouslyAllowBrowser: true
    })
  }

  // Only reached when a caller supplies no messages of its own. The
  // orchestrator always does, and builds this same string itself.
  private buildInstructions(examples?: ExampleScript[], targetMinutes?: number): string {
    return buildGenerationSystemPrompt(buildLengthPlan(targetMinutes), examples ?? [])
  }

  private chatMessagesToOpenAI(messages: ChatMessage[]): Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }))
  }

  async *generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    let finalMessages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = []

    if (messages && messages.length > 0) {
      finalMessages = this.chatMessagesToOpenAI(messages)
    } else {
      const systemMessage = this.buildInstructions(examples, request.targetMinutes)
      finalMessages.push({ role: 'system', content: systemMessage })
      finalMessages.push({ role: 'user', content: request.prompt })
    }

    yield* this.streamCompletion(finalMessages, abortSignal, {
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
    const finalMessages = this.chatMessagesToOpenAI(messages)
    yield* this.streamCompletion(finalMessages, abortSignal, {
      label: request.sectionTitle || 'Refinement'
    }, options)
  }

  private async *streamCompletion(
    messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
    abortSignal: AbortSignal | undefined,
    context: TranscriptContext,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    yield* streamOpenAiCompatible({
      client: this.client,
      provider: 'openrouter',
      model: getModel(),
      // As in the OpenAI service: the tool exchange is appended at send time
      messages: [...messages, ...toolTurnsToOpenAI(options?.toolTurns)],
      ...(options?.tools && options.tools.length > 0 && {
        extras: { tools: [...options.tools] }
      }),
      abortSignal,
      label: context.label,
      exampleIds: context.exampleIds
    })
  }
}
