import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { ProviderFrame } from './providerFrame'
import type { ScriptGenerationService, ProviderCallOptions } from './scriptGenerationService'
import type { LiveProvider } from './providerStatus'
import type { ReasoningLevel } from './config'

// The seam that keeps pi-ai out of the first paint. piAi.ts pulls in pi-ai's
// core, and a static import from the service factory would put all of it in
// the entry chunk — downloaded and parsed before the app renders, by every
// session, including the many that only ever read a script they already have.
// Loading the module on first use instead costs one already-async step on a
// path that is about to wait on a network request anyway, and the factory stays
// synchronous, so no caller has to know.
//
// This matters MORE now that pi is the default, not less: the cost used to fall
// only on sessions that opted in, and would now fall on all of them.
//
// The methods are async generators, which the interface already requires, so
// the await is free: nothing is loaded until the first frame is pulled.
export class DeferredPiAiService implements ScriptGenerationService {
  private readonly apiKey: string
  private readonly provider: LiveProvider
  private readonly reasoning: ReasoningLevel

  constructor(apiKey: string, provider: LiveProvider, reasoning: ReasoningLevel = 'provider') {
    this.apiKey = apiKey
    this.provider = provider
    this.reasoning = reasoning
  }

  private async load(): Promise<ScriptGenerationService> {
    const { PiAiService } = await import('./piAi')
    return new PiAiService(this.apiKey, this.provider, this.reasoning)
  }

  async *generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    const service = await this.load()
    yield* service.generateScript(request, messages, examples, abortSignal, options)
  }

  async *regenerateSection(
    request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown> {
    const service = await this.load()
    yield* service.regenerateSection(request, messages, abortSignal, options)
  }
}
