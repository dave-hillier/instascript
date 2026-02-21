import OpenAI from 'openai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import { getSystemPrompt, formatExamplesForPrompt } from './prompts'
import type { ScriptGenerationService } from './scriptGenerationService'
import { getModel } from './config'

export class OpenRouterService implements ScriptGenerationService {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      dangerouslyAllowBrowser: true
    })
  }

  private buildInstructions(examples?: ExampleScript[]): string {
    let instructions = getSystemPrompt()

    if (examples && examples.length > 0) {
      instructions += formatExamplesForPrompt(examples)
    }

    return instructions
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
      const systemMessage = this.buildInstructions(examples)
      finalMessages.push({ role: 'system', content: systemMessage })
      finalMessages.push({ role: 'user', content: request.prompt })
    }

    yield* this.streamCompletion(finalMessages, abortSignal)
  }

  async *regenerateSection(
    _request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const finalMessages = this.chatMessagesToOpenAI(messages)
    yield* this.streamCompletion(finalMessages, abortSignal)
  }

  private async *streamCompletion(
    messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    try {
      const requestOptions = abortSignal ? { signal: abortSignal } : {}

      const response = await this.client.chat.completions.create({
        model: getModel(),
        messages: messages,
        stream: true
      }, requestOptions) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          yield delta
        }
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        return
      }
      console.error('OpenRouter generation error:', error)
      throw error
    }
  }
}
