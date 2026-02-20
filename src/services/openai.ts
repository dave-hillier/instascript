import OpenAI from 'openai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import { getSystemPrompt, formatExamplesForPrompt } from './prompts'
import type { ExampleScript } from './exampleSearchService'
import type { ScriptGenerationService } from './scriptGenerationService'
import { getModel } from './config'

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

  private buildInstructions(examples?: ExampleScript[]): string {
    let instructions = getSystemPrompt()
    
    // Add examples to instructions if provided
    if (examples && examples.length > 0) {
      instructions += formatExamplesForPrompt(examples)
    }

    return instructions
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
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
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
      const systemMessage = this.buildInstructions(examples)
      finalMessages.push({ role: 'system', content: systemMessage })
      finalMessages.push({ role: 'user', content: request.prompt })
    }

    yield* this.streamCompletion(finalMessages, abortSignal)
  }

  async *regenerateSection(
    request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    console.debug('OpenAIService.regenerateSection called', {
      messagesCount: messages.length,
      sectionTitle: request.sectionTitle
    })
    
    const finalMessages = this.chatMessagesToOpenAI(messages)
    yield* this.streamCompletion(finalMessages, abortSignal)
  }

  private async *streamCompletion(
    messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    try {
      // Generate a prompt cache key based on system message (which includes examples)
      // This ensures requests with the same examples get cached together
      const systemMessage = messages.find(msg => msg.role === 'system')
      const systemContent = systemMessage?.content
      const promptCacheKey = systemContent && typeof systemContent === 'string'
        ? `system-${this.generateCacheKeyHash(systemContent)}`
        : undefined

      const completionsPayload = {
        model: getModel(),
        messages: messages,
        stream: true,
        temperature: 1, // Not supported on gpt-5 
        ...(promptCacheKey && { prompt_cache_key: promptCacheKey })
      }
      
      const requestOptions = abortSignal ? { signal: abortSignal } : {}
      
      console.debug('OpenAI Chat Completions API Request:', {
        ...completionsPayload,
        promptCacheKey,
        systemMessageLength: systemMessage?.content?.length || 0,
        totalMessages: messages.length,
        hasAbortSignal: !!abortSignal
      })
      
      // Use the Chat Completions API with streaming
      const response = await this.client.chat.completions.create(completionsPayload, requestOptions) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

      // Stream the response chunks
      let isFirstChunk = true
      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          yield delta
        }
        
        // Log cache performance on first chunk
        if (isFirstChunk && chunk.usage) {
          isFirstChunk = false
          const usage = chunk.usage
          const promptTokensDetails = usage.prompt_tokens_details
          if (promptTokensDetails?.cached_tokens !== undefined) {
            const totalPromptTokens = usage.prompt_tokens || 0
            const cachedTokens = promptTokensDetails.cached_tokens
            const cacheHitRate = totalPromptTokens ? (cachedTokens / totalPromptTokens * 100).toFixed(1) : '0'
            console.debug('Prompt Cache Performance:', {
              promptCacheKey,
              totalPromptTokens,
              cachedTokens,
              cacheHitRate: `${cacheHitRate}%`,
              cacheEnabled: cachedTokens > 0
            })
          }
        }
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        console.debug('Generation aborted by user')
        return
      }
      console.error('Generation error:', error)
      throw error
    }
  }
}