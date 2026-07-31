import { canUseOpenAI, canUseOpenRouter, type APIProvider, type AppConfig } from './config'

// Which provider a request will actually reach, as opposed to which one is
// selected in settings. The two used to diverge silently: choosing OpenRouter
// but holding no key fell through to the mock, which returns canned scripts
// that look like real output. Every caller that needs to know what really
// happens — the factory, the script metadata, the UI — resolves it here.

export type LiveProvider = 'openai' | 'openrouter'

export type ProviderStatus =
  // A real provider with a key: requests go out over the network
  | { kind: 'live'; provider: LiveProvider }
  // The mock was chosen deliberately in settings
  | { kind: 'mock' }
  // A real provider was chosen but has no key. Nothing can be generated, and
  // substituting the mock here is what made the failure invisible.
  | { kind: 'missing-key'; provider: LiveProvider }

export const PROVIDER_LABELS: Record<APIProvider, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  mock: 'the mock provider'
}

export function resolveProviderStatus(config: AppConfig): ProviderStatus {
  if (canUseOpenRouter(config)) return { kind: 'live', provider: 'openrouter' }
  if (canUseOpenAI(config)) return { kind: 'live', provider: 'openai' }
  if (config.apiProvider === 'mock') return { kind: 'mock' }
  return { kind: 'missing-key', provider: config.apiProvider }
}

// What to record on a script as the provider that wrote it. Scripts used to
// store the configured provider, so a wholly mocked script was labelled
// "openrouter" and looked like a real generation gone wrong.
export function providerUsedFor(status: ProviderStatus): APIProvider {
  return status.kind === 'live' ? status.provider : 'mock'
}

// Human-readable reason a generation cannot run, or null when it can
export function unavailableReason(status: ProviderStatus): string | null {
  if (status.kind !== 'missing-key') return null
  return `No ${PROVIDER_LABELS[status.provider]} API key is set. Add one in Settings to generate scripts.`
}

export class MissingApiKeyError extends Error {
  readonly provider: LiveProvider

  constructor(provider: LiveProvider) {
    super(
      `No ${PROVIDER_LABELS[provider]} API key is set, so nothing can be generated. ` +
      'Add a key in Settings, or select the mock provider there if you want placeholder output.'
    )
    this.name = 'MissingApiKeyError'
    this.provider = provider
  }
}
