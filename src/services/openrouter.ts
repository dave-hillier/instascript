import OpenAI from 'openai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import { buildGenerationSystemPrompt } from './prompts'
import type { ScriptGenerationService } from './scriptGenerationService'
import { getModel } from './config'
import { buildLengthPlan } from './scriptLength'
import { beginTranscript, exampleIdsOf, toTranscriptMessages } from './debugTranscript'
import type { TranscriptContext } from './debugTranscript'

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
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
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
    })
  }

  async *regenerateSection(
    request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const finalMessages = this.chatMessagesToOpenAI(messages)
    yield* this.streamCompletion(finalMessages, abortSignal, {
      label: request.sectionTitle || 'Refinement'
    })
  }

  private async *streamCompletion(
    messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
    abortSignal: AbortSignal | undefined,
    context: TranscriptContext
  ): AsyncGenerator<string, void, unknown> {
    const model = getModel()
    // Records exactly what goes to the provider, examples and all, when the
    // debug transcript option is on
    const transcript = beginTranscript({
      provider: 'openrouter',
      model,
      label: context.label,
      exampleIds: context.exampleIds,
      messages: toTranscriptMessages(messages)
    })

    try {
      const requestOptions = abortSignal ? { signal: abortSignal } : {}

      const response = await this.client.chat.completions.create({
        model,
        messages: messages,
        stream: true
      }, requestOptions) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          transcript.appendChunk(delta)
          yield delta
        }
      }

      transcript.complete()
    } catch (error) {
      if (abortSignal?.aborted) {
        transcript.abort()
        return
      }
      transcript.fail(error)
      console.error('OpenRouter generation error:', error)
      throw error
    }
  }
}
