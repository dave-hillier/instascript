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

  private buildInstructions(examples?: ExampleScript[]): string {
    let instructions = PromptService.getSystemPrompt()
    
    // Add examples to instructions if provided
    if (examples && examples.length > 0) {
      instructions += formatExamplesForPrompt(examples)
    }

    return instructions
  }

  private conversationToInput(conversation: Conversation): string {
    // For Responses API, we should only pass user messages
    // Assistant messages are handled differently (via previous_response_id in stateful mode)
    // Since we're not using previous_response_id, we'll simulate conversation context
    
    // Get only user messages
    const userMessages = conversation.messages.filter(msg => msg.role === 'user')
    
    // For regeneration, we want the full context, so let's build a conversation string
    // that includes both user and assistant messages as context
    if (conversation.messages.length > 1) {
      // Build a conversation context string
      let contextString = ''
      
      // Add conversation history as context
      for (const msg of conversation.messages) {
        if (msg.role === 'system') continue // Skip system messages
        
        if (msg.role === 'user') {
          contextString += `User: ${msg.content}\n\n`
        } else if (msg.role === 'assistant') {
          contextString += `Previous response:\n${msg.content}\n\n`
        }
      }
      
      console.debug('Built conversation context string:', {
        originalMessageCount: conversation.messages.length,
        contextLength: contextString.length
      })
      
      return contextString.trim()
    }
    
    // For single user message, just return the content as a string
    if (userMessages.length === 1) {
      return userMessages[0].content
    }
    
    // Fallback to empty string
    return ''
  }

  async *generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown> {
    console.debug('OpenAIService.generateScript called', {
      hasConversation: !!conversation,
      examplesCount: examples?.length || 0,
      regenerate: request.regenerate,
      sectionId: request.sectionId
    })
    
    // Build instructions from system prompt and examples
    const instructions = this.buildInstructions(examples)

    // Build input based on context
    let input: string
    
    if (conversation && conversation.messages.length > 0) {
      // For conversations with history, build context string
      const conversationContext = this.conversationToInput(conversation)
      
      // If regenerating, append the regeneration prompt
      if (request.regenerate && request.sectionId) {
        const section = conversation.sections.find(s => s.id === request.sectionId)
        if (section) {
          // Combine context with regeneration instruction
          input = conversationContext + '\n\n' + PromptService.getSectionRegenerationPrompt(section.title)
        } else {
          input = conversationContext
        }
      } else {
        input = conversationContext
      }
    } else {
      // For single prompts, use the prompt directly
      input = request.prompt
    }

    try {
      // Log the full request for debugging
      console.debug('OpenAI Responses API Request:', {
        model: 'gpt-5-mini-2025-08-07',
        instructionsLength: instructions.length,
        instructionsPreview: instructions.substring(0, 100),
        inputType: typeof input,
        inputIsArray: Array.isArray(input),
        inputLength: Array.isArray(input) ? input.length : (input as string).length,
        fullInput: JSON.stringify(input, null, 2)
      })
      
      // Create the request payload with proper typing for streaming
      const requestPayload: OpenAI.Responses.ResponseCreateParamsStreaming = {
        model: 'gpt-5-mini-2025-08-07',
        instructions: instructions,
        input: input,
        stream: true,
        store: true
      }
      
      console.debug('Request payload before SDK:', JSON.stringify(requestPayload, null, 2))
      
      // Use the Responses API with proper typing for streaming
      const response = await this.client.responses.create(requestPayload)

      // Now we can safely iterate over the stream
      for await (const chunk of response) {
        // Handle the streaming events based on type
        if (chunk.type === 'response.output_text.delta' && 'delta' in chunk) {
          yield chunk.delta
        }
      }
    } catch (error) {
      console.error('Generation error:', error)
      throw error
    }
  }
}