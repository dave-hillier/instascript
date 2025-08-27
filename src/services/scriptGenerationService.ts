import type { GenerationRequest, Conversation } from '../types/conversation'
import type { ExampleScript } from './vectorStore'

export interface ScriptGenerationService {
  generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown>
}