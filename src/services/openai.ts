import OpenAI from 'openai'
import type { GenerationRequest, Conversation } from '../types/conversation'
import { PromptService } from './prompts'
import type { ExampleScript } from './vectorStore'
import type { ScriptGenerationService } from './scriptGenerationService'
import { formatExamplesForPrompt } from './exampleSearchService'

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
    let instructions = PromptService.getSystemPrompt()
    
    // Add examples to instructions if provided
    if (examples && examples.length > 0) {
      instructions += formatExamplesForPrompt(examples)
    }

    return instructions
  }

  private conversationToMessages(conversation: Conversation, excludeSystemMessages = false): Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    // Convert conversation messages to OpenAI chat format
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = []
    
    // Add conversation history
    for (const msg of conversation.messages) {
      if (msg.role === 'system' && !excludeSystemMessages) {
        messages.push({ role: 'system', content: msg.content })
      } else if (msg.role === 'user') {
        messages.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content })
      }
    }
    
    console.debug('Built conversation messages:', {
      originalMessageCount: conversation.messages.length,
      convertedMessageCount: messages.length,
      excludedSystemMessages: excludeSystemMessages
    })
    
    return messages
  }

  async *generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    console.debug('OpenAIService.generateScript called', {
      hasConversation: !!conversation,
      examplesCount: examples?.length || 0,
      regenerate: request.regenerate,
      sectionId: request.sectionId
    })
    
    // Build messages array for chat completions
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = []
    
    // Add system message with instructions and examples
    const systemMessage = this.buildInstructions(examples)
    messages.push({ role: 'system', content: systemMessage })
    
    if (conversation && conversation.messages.length > 0) {
      // Add existing conversation messages, excluding system messages to avoid duplicates
      // since we're adding our own system message with current examples above
      const conversationMessages = this.conversationToMessages(conversation, true)
      messages.push(...conversationMessages)
      
      // If regenerating a specific section, add regeneration prompt
      if (request.regenerate && request.sectionId) {
        const section = conversation.sections.find(s => s.id === request.sectionId)
        if (section) {
          const regenerationPrompt = PromptService.getSectionRegenerationPrompt(section.title)
          messages.push({ role: 'user', content: regenerationPrompt })
        }
      }
    } else {
      // For new conversations, add the initial prompt
      messages.push({ role: 'user', content: request.prompt })
    }

    try {
      // Generate a prompt cache key based on system message (which includes examples)
      // This ensures requests with the same examples get cached together
      const systemMessage = messages.find(msg => msg.role === 'system')
      const systemContent = systemMessage?.content
      const promptCacheKey = systemContent && typeof systemContent === 'string'
        ? `system-${this.generateCacheKeyHash(systemContent)}`
        : undefined

      // Get model from localStorage with fallback to gpt-5-mini
      const getModelFromStorage = (): string => {
        try {
          const item = window.localStorage.getItem('model')
          return item ? JSON.parse(item) : 'gpt-5-mini'
        } catch {
          return 'gpt-5-mini'
        }
      }

      const completionsPayload = {
        model: getModelFromStorage(),
        messages: messages,
        stream: true,
        temperature: 1, // Not supported on gpt-5 
        ...(promptCacheKey && { prompt_cache_key: promptCacheKey })
      }
      
      const requestOptions = abortSignal ? { signal: abortSignal } : {}
      
      console.debug('OpenAI Chat Completions API Request:', {
        ...completionsPayload,
        promptCacheKey,
        systemMessageLength: systemMessage?.content.length || 0,
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