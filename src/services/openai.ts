import OpenAI from 'openai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import { buildGenerationSystemPrompt } from './prompts'
import type { ExampleScript } from './exampleSearchService'
import type { ScriptGenerationService, ProviderCallOptions } from './scriptGenerationService'
import { toolTurnsToOpenAI } from './scriptGenerationService'
import { getModel } from './config'
import { buildLengthPlan } from './scriptLength'
import { exampleIdsOf } from './debugTranscript'
import type { TranscriptContext } from './debugTranscript'
import { streamOpenAiCompatible } from './openAiCompatibleStream'
import type { ProviderFrame } from './providerFrame'

export class OpenAIService implements ScriptGenerationService {
  private client: OpenAI

  constructor(apiKey: string) {
    console.debug('OpenAIService created with API key', {
      apiKeyLength: apiKey.length,
      apiKeyPrefix: apiKey.substring(0, 7) + '...'
    })

    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true // Note: In production, API calls should be made from the server
    })
  }

  private generateCacheKeyHash(content: string): string {
    // Generate a stable hash for cache key based on content
    // Using a simple hash function for consistent cache routing
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36)
  }

  // Only reached when a caller supplies no messages of its own. The
  // orchestrator always does, and builds this same string itself.
  private buildInstructions(examples?: ExampleScript[], targetMinutes?: number): string {
    return buildGenerationSystemPrompt(buildLengthPlan(targetMinutes), examples ?? [])
  }

  private chatMessagesToOpenAI(messages: ChatMessage[]): Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    // Convert ChatMessage[] to OpenAI chat format
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
    console.debug('OpenAIService.generateScript called', {
      messagesCount: messages?.length || 0,
      examplesCount: examples?.length || 0
    })

    let finalMessages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = []

    if (messages && messages.length > 0) {
      // Use provided messages directly (already includes system + examples + conversation history)
      finalMessages = this.chatMessagesToOpenAI(messages)
    } else {
      // For new conversations, build from scratch
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
    console.debug('OpenAIService.regenerateSection called', {
      messagesCount: messages.length,
      sectionTitle: request.sectionTitle
    })

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
    // Generate a prompt cache key based on system message (which includes examples)
    // This ensures requests with the same examples get cached together
    const systemMessage = messages.find(msg => msg.role === 'system')
    const systemContent = systemMessage?.content
    const promptCacheKey = systemContent && typeof systemContent === 'string'
      ? `system-${this.generateCacheKeyHash(systemContent)}`
      : undefined

    yield* streamOpenAiCompatible({
      client: this.client,
      provider: 'openai',
      model: getModel(),
      // The tool exchange rides after the stored history, never inside it:
      // a tool result has to follow the assistant turn that made the call
      messages: [...messages, ...toolTurnsToOpenAI(options?.toolTurns)],
      extras: {
        temperature: 1, // Not supported on gpt-5
        ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
        // Offered whole on every generation request (D4), so the tool list is
        // identical between requests and the prompt cache is never spent on a
        // change the cache key — hashed from the system message alone — cannot
        // see. An absent list leaves the payload byte-identical to the prose
        // path's.
        ...(options?.tools && options.tools.length > 0 && { tools: [...options.tools] })
      },
      abortSignal,
      label: context.label,
      exampleIds: context.exampleIds,
      transcriptParams: { temperature: 1, promptCacheKey }
    })
  }
}
