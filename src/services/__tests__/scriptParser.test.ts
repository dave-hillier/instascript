import { describe, it, expect } from 'vitest'
import { serializeScriptToYamlMarkdown, parseScriptFromYamlMarkdown } from '../scriptParser'
import type { Script } from '../../types/script'

const script = (overrides: Partial<Script> = {}): Script => ({
  id: 's1',
  title: 'Deep Rest',
  content: '## Induction\nBreathe.',
  createdAt: '2026-07-25T00:00:00.000Z',
  isArchived: false,
  ...overrides
})

// Scripts are stored as YAML front matter, and every rewrite, refinement and
// review after a reload replans against whatever length survives that trip
describe('script storage round trip', () => {
  it('preserves the requested length', () => {
    const stored = serializeScriptToYamlMarkdown(script({ targetMinutes: 60 }))

    expect(parseScriptFromYamlMarkdown(stored)?.targetMinutes).toBe(60)
  })

  it('leaves the requested length unset when the script never had one', () => {
    const stored = serializeScriptToYamlMarkdown(script())

    expect(parseScriptFromYamlMarkdown(stored)?.targetMinutes).toBeUndefined()
  })
})
