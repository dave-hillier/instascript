import type { GenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './vectorStore'

export interface ScriptGenerationService {
  generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown>
}