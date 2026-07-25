import { describe, it, expect } from 'vitest'
import { testApiConnection, describeConnectionFailure } from '../connectionTest'

const fetchReturning = (status: number, capture?: { url?: string; auth?: string }): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = String(input)
      const headers = init?.headers as Record<string, string> | undefined
      capture.auth = headers?.Authorization
    }
    return Promise.resolve({ ok: status >= 200 && status < 300, status } as Response)
  }) as typeof fetch

describe('testApiConnection', () => {
  it('reports success when the models endpoint accepts the key', async () => {
    const capture: { url?: string; auth?: string } = {}
    const result = await testApiConnection('openai', 'sk-test', fetchReturning(200, capture))

    expect(result.ok).toBe(true)
    expect(result.message).toContain('OpenAI')
    expect(capture.url).toBe('https://api.openai.com/v1/models')
    expect(capture.auth).toBe('Bearer sk-test')
  })

  it('uses the authenticated OpenRouter models endpoint', async () => {
    const capture: { url?: string; auth?: string } = {}
    const result = await testApiConnection('openrouter', 'or-key', fetchReturning(200, capture))

    expect(result.ok).toBe(true)
    expect(capture.url).toBe('https://openrouter.ai/api/v1/models/user')
  })

  it('explains a rejected key', async () => {
    const result = await testApiConnection('openai', 'sk-bad', fetchReturning(401))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
  })

  it('reports other HTTP failures with their status', async () => {
    const result = await testApiConnection('openrouter', 'or-key', fetchReturning(500))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('500')
  })

  it('reports a network failure without throwing', async () => {
    const failingFetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    const result = await testApiConnection('openai', 'sk-test', failingFetch)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Could not reach')
  })

  it('refuses to test an empty key', async () => {
    const result = await testApiConnection('openai', '   ')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Enter an API key')
  })
})

describe('describeConnectionFailure', () => {
  it('names the provider in every reason', () => {
    for (const status of [401, 403, 429, 500]) {
      expect(describeConnectionFailure('openrouter', status)).toContain('OpenRouter')
    }
  })
})
