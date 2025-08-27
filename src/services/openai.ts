import OpenAI from 'openai'
import type { GenerationRequest, Conversation } from '../types/conversation'
import { PromptService } from './prompts'
import type { ExampleScript } from './vectorStore'
import type { ScriptGenerationService } from './scriptGenerationService'
import { formatExamplesForPrompt } from './exampleSearchService'

export class OpenAIService implements ScriptGenerationService {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true // Note: In production, API calls should be made from the server
    })
  }

  private conversationToResponseInput(
    conversation: Conversation,
    examples?: ExampleScript[]
  ): OpenAI.Responses.ResponseInputItem[] {
    let systemContent = PromptService.getSystemPrompt()
    
    // Add examples to system prompt if provided
    if (examples && examples.length > 0) {
      systemContent += formatExamplesForPrompt(examples)
    }

    const systemMessage: OpenAI.Responses.ResponseInputItem = {
      role: 'system',
      content: [{ type: 'input_text', text: systemContent }]
    }

    const conversationMessages: OpenAI.Responses.ResponseInputItem[] = conversation.messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: [{ type: 'input_text', text: msg.content }]
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
      systemPrompt += formatExamplesForPrompt(examples)
    }

    const messages: OpenAI.Responses.ResponseInputItem[] = conversation 
      ? this.conversationToResponseInput(conversation, examples)
      : [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: request.prompt }] }
        ]

    // If regenerating a specific section, add the specific regeneration instruction
    if (request.regenerate && request.sectionId && conversation) {
      const section = conversation.sections.find(s => s.id === request.sectionId)
      if (section) {
        // Add the specific regeneration instruction
        messages.push({
          role: 'user', 
          content: [{ type: 'input_text', text: PromptService.getSectionRegenerationPrompt(section.title) }]
        })
      }
    }

    try {
      // Use the Responses API for streaming responses
      const stream = await this.client.responses.create({
        model: 'gpt-5-mini-2025-08-07',//'gpt-5',
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