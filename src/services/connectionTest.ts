// Test-connection support for story 5.4: verifies an API key with a cheap
// authenticated request against the provider's models endpoint, returning a
// human-readable outcome instead of throwing.

export type TestableProvider = 'openai' | 'openrouter'

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

// OpenAI's models list is authenticated. OpenRouter's public /models endpoint
// ignores the Authorization header, so the key-scoped /models/user variant is
// used there — it is the cheap models-list call that actually checks the key.
const MODELS_ENDPOINTS: Record<TestableProvider, string> = {
  openai: 'https://api.openai.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models/user'
}

const PROVIDER_NAMES: Record<TestableProvider, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter'
}

// Maps an HTTP failure status to the reason shown inline in settings.
export const describeConnectionFailure = (provider: TestableProvider, status: number): string => {
  const name = PROVIDER_NAMES[provider]
  switch (status) {
    case 401:
      return `${name} rejected the API key (401 Unauthorized). Check the key and try again.`
    case 403:
      return `${name} refused the request (403 Forbidden). The key may lack permission for this API.`
    case 429:
      return `${name} is rate limiting requests (429). The key was accepted but the account may be out of quota.`
    default:
      return `${name} responded with HTTP ${status}.`
  }
}

export const testApiConnection = async (
  provider: TestableProvider,
  apiKey: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init)
): Promise<ConnectionTestResult> => {
  const key = apiKey.trim()
  if (!key) {
    return { ok: false, message: 'Enter an API key first.' }
  }

  try {
    const response = await fetchFn(MODELS_ENDPOINTS[provider], {
      headers: { Authorization: `Bearer ${key}` }
    })
    if (response.ok) {
      return {
        ok: true,
        message: `Connected to ${PROVIDER_NAMES[provider]} — the API key works.`
      }
    }
    return { ok: false, message: describeConnectionFailure(provider, response.status) }
  } catch {
    return {
      ok: false,
      message: `Could not reach ${PROVIDER_NAMES[provider]} — check your network connection.`
    }
  }
}
