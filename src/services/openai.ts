import OpenAI from 'openai'
import type { GenerationRequest, Conversation } from '../types/conversation'
import { PromptService } from './prompts'
import { ExampleService } from './exampleService'
import type { ExampleScript } from './vectorStore'

export class OpenAIService {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true // Note: In production, API calls should be made from the server
    })
  }

  private conversationToMessages(
    conversation: Conversation,
    examples?: ExampleScript[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    let systemContent = PromptService.getSystemPrompt()
    
    // Add examples to system prompt if provided
    if (examples && examples.length > 0) {
      systemContent += ExampleService.formatExamplesForPrompt(examples)
    }

    const systemMessage: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam = {
      role: 'system',
      content: systemContent
    }

    const conversationMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = conversation.messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content
    }))

    return [systemMessage, ...conversationMessages]
  }

  async *generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown> {
    let systemPrompt = PromptService.getSystemPrompt()
    
    // Add examples to system prompt if provided
    if (examples && examples.length > 0) {
      systemPrompt += ExampleService.formatExamplesForPrompt(examples)
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = conversation 
      ? this.conversationToMessages(conversation, examples)
      : [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: request.prompt }
        ]

    // If regenerating a specific section, add the specific regeneration instruction
    if (request.regenerate && request.sectionId && conversation) {
      const section = conversation.sections.find(s => s.id === request.sectionId)
      if (section) {
        // Add the specific regeneration instruction
        messages.push({
          role: 'user', 
          content: PromptService.getSectionRegenerationPrompt(section.title)
        })
      }
    }

    try {
      // Use the Responses API for streaming responses
      const stream = await this.client.responses.create({
        model: 'gpt-5',
        input: messages,
        stream: true,
      })

      for await (const chunk of stream) {
        if (chunk.type === 'response.output_text.delta') {
          yield chunk.delta
        }
      }
    } catch (error) {
      console.error('Generation error:', error)
      throw error
    }
  }
}