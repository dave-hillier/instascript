import type { GenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './vectorStore'
import type { AppConfig } from './config'
import { OpenAIService } from './openai'
import { MockAPIService } from './mockApi'
import { canUseOpenAI } from './config'

/**
 * Pure function to generate a script using the appropriate service
 * No side effects - returns an async generator for streaming
 */
export async function* generateScript(
  config: AppConfig,
  request: GenerationRequest,
  messages?: ChatMessage[],
  examples?: ExampleScript[],
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  
  let service
  if (canUseOpenAI(config)) {
    service = new OpenAIService(config.apiKey!)
  } else {
    service = new MockAPIService()
  }

  yield* service.generateScript(request, messages, examples, abortSignal)
}