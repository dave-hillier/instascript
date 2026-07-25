import { describe, it, expect } from 'vitest'
import {
  parseExampleMarkdown,
  serializeExampleToMarkdown,
  parseTags
} from '../exampleCorpus'
import type { ExampleRecord } from '../../types/example'

describe('parseExampleMarkdown', () => {
  it('reads title and tags from YAML front matter', () => {
    const raw = `---
title: Evening Calm
tags:
  - sleep
  - calm
---
# Evening Calm

## Induction
Breathe out slowly.`

    const parsed = parseExampleMarkdown(raw, 'fallback')
    expect(parsed.title).toBe('Evening Calm')
    expect(parsed.tags).toEqual(['sleep', 'calm'])
    expect(parsed.content).toContain('## Induction')
    expect(parsed.content).not.toContain('---\ntitle')
  })

  it('falls back to the first heading when there is no front matter', () => {
    const parsed = parseExampleMarkdown('# Morning Focus\n\nBody text.', 'file-name')
    expect(parsed.title).toBe('Morning Focus')
    expect(parsed.tags).toEqual([])
  })

  it('falls back to the supplied title when there is no heading', () => {
    const parsed = parseExampleMarkdown('Just prose, no heading.', 'my-example')
    expect(parsed.title).toBe('my-example')
    expect(parsed.content).toBe('Just prose, no heading.')
  })

  it('accepts comma-separated tags in front matter', () => {
    const raw = `---
title: Tagged
tags: sleep, Calm , rest
---
Content.`
    const parsed = parseExampleMarkdown(raw, 'fallback')
    expect(parsed.tags).toEqual(['sleep', 'calm', 'rest'])
  })

  it('round-trips through serialization', () => {
    const record: ExampleRecord = {
      id: 'example_test',
      title: 'Round Trip',
      tags: ['sleep', 'rest'],
      content: '# Round Trip\n\n## Induction\nSettle in.',
      source: 'user',
      createdAt: 1234567890
    }

    const serialized = serializeExampleToMarkdown(record)
    const parsed = parseExampleMarkdown(serialized, 'fallback')

    expect(parsed.title).toBe('Round Trip')
    expect(parsed.tags).toEqual(['sleep', 'rest'])
    expect(parsed.content).toBe(record.content)
    expect(parsed.createdAt).toBe(1234567890)
  })
})

describe('parseTags', () => {
  it('splits, trims, lowercases and drops empties', () => {
    expect(parseTags(' Sleep, CALM ,, rest ')).toEqual(['sleep', 'calm', 'rest'])
  })

  it('returns an empty list for blank input', () => {
    expect(parseTags('  ')).toEqual([])
  })
})
