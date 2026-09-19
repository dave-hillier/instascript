import { describe, it, expect, afterEach, vi } from 'vitest'
import { getLlmEngine, getReasoning } from '../config'

// The settings read here are consulted on the way into a generation run, which
// is exercised in a node process with no window at all, so storage is stubbed
// rather than assumed.
const stubStorage = (entries: Record<string, string>): void => {
  const store = new Map(Object.entries(entries))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key)
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLlmEngine', () => {
  it('defaults to pi-ai when nothing has been chosen', () => {
    stubStorage({})

    expect(getLlmEngine()).toBe('pi')
  })

  it('honours an explicit choice of either engine', () => {
    stubStorage({ llmEngine: JSON.stringify('sdk') })
    expect(getLlmEngine()).toBe('sdk')

    stubStorage({ llmEngine: JSON.stringify('pi') })
    expect(getLlmEngine()).toBe('pi')
  })

  // A value nobody picked is not a considered choice, so it lands on the
  // default rather than on an engine that does not exist
  it('falls back to the default for a value it does not recognise', () => {
    stubStorage({ llmEngine: JSON.stringify('something-else') })

    expect(getLlmEngine()).toBe('pi')
  })
})

describe('getReasoning', () => {
  // The default sends no reasoning parameter at all, so a run is whatever the
  // model does by default — which is what every run did before the setting
  it('defaults to leaving reasoning to the model', () => {
    stubStorage({})

    expect(getReasoning()).toBe('provider')
  })

  it('honours each level it offers', () => {
    for (const level of ['provider', 'off', 'low', 'medium', 'high'] as const) {
      stubStorage({ reasoning: JSON.stringify(level) })
      expect(getReasoning()).toBe(level)
    }
  })

  it('falls back to the default for a level no provider would accept', () => {
    stubStorage({ reasoning: JSON.stringify('maximum') })

    expect(getReasoning()).toBe('provider')
  })
})
