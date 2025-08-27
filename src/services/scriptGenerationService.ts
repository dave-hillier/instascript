import type { GenerationRequest, Conversation } from '../types/conversation'
import type { ExampleScript } from './vectorStore'

export interface ScriptGenerationService {
  generateScript(
    request: GenerationRequest,
    conversation?: Conversation,
    examples?: ExampleScript[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown>
}