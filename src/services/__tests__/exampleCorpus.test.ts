import { describe, it, expect } from 'vitest'
import {
  parseExampleMarkdown,
  serializeExampleToMarkdown,
  parseTags,
  parseSelectionCounts,
  sanitizeSelectionCounts,
  incrementSelectionCounts,
  mergeSelectionCounts
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

  it('round-trips a stored embedding through serialization', () => {
    const record: ExampleRecord = {
      id: 'example_embedded',
      title: 'Embedded',
      tags: ['calm'],
      content: 'Body text.',
      source: 'user',
      createdAt: 1,
      embedding: [0.123456789, -0.5, 1]
    }

    const parsed = parseExampleMarkdown(serializeExampleToMarkdown(record), 'fallback')
    expect(parsed.embedding).toEqual([0.12346, -0.5, 1])
    expect(parsed.content).toBe('Body text.')
  })

  it('omits the embedding key entirely when absent', () => {
    const record: ExampleRecord = {
      id: 'example_plain',
      title: 'Plain',
      tags: [],
      content: 'Body.',
      source: 'user',
      createdAt: 1
    }
    expect(serializeExampleToMarkdown(record)).not.toContain('embedding')
  })

  it('migrates pre-embedding entries: parses cleanly with no embedding', () => {
    const legacy = `---
title: Old Entry
tags:
  - sleep
createdAt: 42
---
Legacy body.`
    const parsed = parseExampleMarkdown(legacy, 'fallback')
    expect(parsed.embedding).toBeUndefined()
    expect(parsed.title).toBe('Old Entry')
  })

  it('ignores malformed embedding front matter', () => {
    const raw = `---
title: Broken
embedding:
  - 0.1
  - not-a-number
---
Body.`
    const parsed = parseExampleMarkdown(raw, 'fallback')
    expect(parsed.embedding).toBeUndefined()
  })
})

describe('selection counts (story 8.11)', () => {
  it('parses a stored counts map', () => {
    expect(parseSelectionCounts('{"example_a": 2, "bundled_b": 5}')).toEqual({
      example_a: 2,
      bundled_b: 5
    })
  })

  it('returns empty counts for missing or malformed storage', () => {
    expect(parseSelectionCounts(null)).toEqual({})
    expect(parseSelectionCounts('not json')).toEqual({})
    expect(parseSelectionCounts('[1,2]')).toEqual({})
  })

  it('sanitizes non-numeric and non-positive values', () => {
    expect(
      sanitizeSelectionCounts({ ok: 3, zero: 0, negative: -2, text: 'nope', fractional: 2.7 })
    ).toEqual({ ok: 3, fractional: 2 })
  })

  it('increments one selection per example id without mutating the input', () => {
    const before = { example_a: 1 }
    const after = incrementSelectionCounts(before, ['example_a', 'example_b'])

    expect(after).toEqual({ example_a: 2, example_b: 1 })
    expect(before).toEqual({ example_a: 1 })
  })

  it('merges imported counts by keeping the higher value per example', () => {
    const merged = mergeSelectionCounts(
      { example_a: 4, example_b: 1 },
      { example_a: 2, example_b: 3, example_c: 1 }
    )

    expect(merged).toEqual({ example_a: 4, example_b: 3, example_c: 1 })
  })

  it('is idempotent when re-importing the same counts', () => {
    const existing = { example_a: 2 }
    const once = mergeSelectionCounts(existing, { example_a: 2 })
    const twice = mergeSelectionCounts(once, { example_a: 2 })

    expect(twice).toEqual({ example_a: 2 })
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
