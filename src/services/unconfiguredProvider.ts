import type { ScriptGenerationService } from './scriptGenerationService'
import type { UtilityModelService, UtilityCompletionRequest } from './utilityModelService'
import { MissingApiKeyError, PROVIDER_LABELS, type LiveProvider } from './providerStatus'

// Stands in for a real provider that has been selected without a key. The
// mock used to fill this slot, which meant a keyless session generated
// convincing-looking canned scripts and reported success. These fail instead,
// with a message the generation UI already surfaces.

export class UnconfiguredScriptService implements ScriptGenerationService {
  private readonly provider: LiveProvider

  constructor(provider: LiveProvider) {
    this.provider = provider
  }

  // eslint-disable-next-line require-yield
  async *generateScript(): AsyncGenerator<string, void, unknown> {
    throw new MissingApiKeyError(this.provider)
  }

  // eslint-disable-next-line require-yield
  async *regenerateSection(): AsyncGenerator<string, void, unknown> {
    throw new MissingApiKeyError(this.provider)
  }
}

// The utility role is deliberately softer: its jobs are optional enrichment of
// an import, and callers skip them when the service is not live. So this one
// reports itself as unavailable rather than throwing, but it never invents a
// result the way the mock does.
export class UnconfiguredUtilityService implements UtilityModelService {
  readonly isLive = false
  readonly model: string

  constructor(provider: LiveProvider) {
    this.model = `${PROVIDER_LABELS[provider]} (no API key)`
  }

  async complete(_request: UtilityCompletionRequest): Promise<string> {
    void _request
    return ''
  }
}
