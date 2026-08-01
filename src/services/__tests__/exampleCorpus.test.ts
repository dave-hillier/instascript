import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getEnabledExamples,
  isImportableExampleFile,
  BUNDLED_EXAMPLES_ENABLED_KEY,
  BUNDLED_GROUP,
  DISABLED_GROUPS_KEY,
  UNGROUPED,
  groupFromImportPath,
  isGroupEnabled,
  migrateDisabledGroups,
  normalizeGroupName,
  parseDisabledGroups,
  setGroupEnabled,
  summarizeGroups,
  parseExampleMarkdown,
  serializeExampleToMarkdown,
  parseTags,
  parseSelectionCounts,
  sanitizeSelectionCounts,
  incrementSelectionCounts,
  mergeSelectionCounts
} from '../exampleCorpus'
import type { ExampleRecord } from '../../types/example'

const exampleRecord = (overrides: Partial<ExampleRecord> = {}): ExampleRecord => ({
  id: 'example_test',
  title: 'Round Trip',
  tags: ['sleep', 'rest'],
  group: 'Long form',
  content: '# Round Trip\n\n## Induction\nSettle in.',
  source: 'user',
  createdAt: 1234567890,
  ...overrides
})

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

  it('reads the group from front matter', () => {
    const raw = `---
title: Evening Calm
group: Long form
---
Body.`
    expect(parseExampleMarkdown(raw, 'fallback').group).toBe('Long form')
  })

  it('reports no group when front matter names none or names a blank one', () => {
    expect(parseExampleMarkdown('# Heading\n\nBody.', 'fallback').group).toBeUndefined()
    expect(parseExampleMarkdown('---\ngroup: "   "\n---\nBody.', 'fallback').group).toBeUndefined()
  })

  it('round-trips through serialization', () => {
    const record = exampleRecord()

    const serialized = serializeExampleToMarkdown(record)
    const parsed = parseExampleMarkdown(serialized, 'fallback')

    expect(parsed.title).toBe('Round Trip')
    expect(parsed.tags).toEqual(['sleep', 'rest'])
    expect(parsed.group).toBe('Long form')
    expect(parsed.content).toBe(record.content)
    expect(parsed.createdAt).toBe(1234567890)
  })

  it('round-trips a stored embedding through serialization', () => {
    const record = exampleRecord({
      id: 'example_embedded',
      title: 'Embedded',
      tags: ['calm'],
      content: 'Body text.',
      createdAt: 1,
      embedding: [0.123456789, -0.5, 1]
    })

    const parsed = parseExampleMarkdown(serializeExampleToMarkdown(record), 'fallback')
    expect(parsed.embedding).toEqual([0.12346, -0.5, 1])
    expect(parsed.content).toBe('Body text.')
  })

  it('omits the embedding key entirely when absent', () => {
    const record = exampleRecord({ id: 'example_plain', title: 'Plain', tags: [], content: 'Body.' })
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

describe('isImportableExampleFile', () => {
  it('accepts markdown and plain text, whatever the case', () => {
    expect(isImportableExampleFile('calm.md')).toBe(true)
    expect(isImportableExampleFile('Calm.MARKDOWN')).toBe(true)
    expect(isImportableExampleFile('scripts/sleep/deep-rest.txt')).toBe(true)
    expect(isImportableExampleFile('notes.text')).toBe(true)
  })

  it('skips non-text files that come along with a folder import', () => {
    expect(isImportableExampleFile('scripts/cover.png')).toBe(false)
    expect(isImportableExampleFile('scripts/session.pdf')).toBe(false)
    expect(isImportableExampleFile('scripts/no-extension')).toBe(false)
  })

  it('skips hidden files such as .DS_Store', () => {
    expect(isImportableExampleFile('scripts/.DS_Store')).toBe(false)
    expect(isImportableExampleFile('.hidden.md')).toBe(false)
  })
})

describe('normalizeGroupName', () => {
  it('keeps the name as typed, minus surrounding space', () => {
    expect(normalizeGroupName('  Long form  ')).toBe('Long form')
  })

  it('treats a blank or missing name as ungrouped', () => {
    expect(normalizeGroupName('   ')).toBe(UNGROUPED)
    expect(normalizeGroupName(undefined)).toBe(UNGROUPED)
  })
})

describe('groupFromImportPath', () => {
  it('names the group after the folder holding the file', () => {
    expect(groupFromImportPath('Long form/deep-rest.md', UNGROUPED)).toBe('Long form')
  })

  it('gives a subfolder its own group rather than the top folder', () => {
    expect(groupFromImportPath('Scripts/sleep/deep-rest.md', UNGROUPED)).toBe('sleep')
  })

  it('falls back to the requested group for a file picked on its own', () => {
    expect(groupFromImportPath('deep-rest.md', 'Meditations')).toBe('Meditations')
    expect(groupFromImportPath('deep-rest.md', '')).toBe(UNGROUPED)
  })
})

describe('summarizeGroups', () => {
  const records: ExampleRecord[] = [
    exampleRecord({ id: 'a', group: 'Long form' }),
    exampleRecord({ id: 'b', group: 'Long form' }),
    exampleRecord({ id: 'c', group: BUNDLED_GROUP, source: 'bundled' }),
    exampleRecord({ id: 'd', group: 'Short' })
  ]

  it('counts the examples in each group, in the order they appear', () => {
    expect(summarizeGroups(records, []).map(group => [group.name, group.count])).toEqual([
      ['Long form', 2],
      [BUNDLED_GROUP, 1],
      ['Short', 1]
    ])
  })

  it('marks the groups named in the disabled list as switched off', () => {
    const summaries = summarizeGroups(records, ['Short'])
    expect(summaries.find(group => group.name === 'Short')?.enabled).toBe(false)
    expect(summaries.find(group => group.name === 'Long form')?.enabled).toBe(true)
  })

  it('marks a wholly bundled group read-only and a group with user examples editable', () => {
    const summaries = summarizeGroups(records, [])
    expect(summaries.find(group => group.name === BUNDLED_GROUP)?.readOnly).toBe(true)
    expect(summaries.find(group => group.name === 'Long form')?.readOnly).toBe(false)
  })

  it('returns no groups for an empty corpus', () => {
    expect(summarizeGroups([], [])).toEqual([])
  })
})

describe('parseDisabledGroups', () => {
  it('reads a stored list, dropping duplicates', () => {
    expect(parseDisabledGroups('["Short","Short","Long form"]')).toEqual(['Short', 'Long form'])
  })

  it('treats missing or malformed storage as nothing disabled', () => {
    expect(parseDisabledGroups(null)).toEqual([])
    expect(parseDisabledGroups('not json')).toEqual([])
    expect(parseDisabledGroups('{"a":1}')).toEqual([])
    expect(parseDisabledGroups('["ok", 3, ""]')).toEqual(['ok'])
  })
})

describe('migrateDisabledGroups', () => {
  it('starts the bundled group switched off, as it was before groups existed', () => {
    expect(migrateDisabledGroups(null)).toEqual([BUNDLED_GROUP])
    expect(migrateDisabledGroups('false')).toEqual([BUNDLED_GROUP])
    expect(migrateDisabledGroups('not json')).toEqual([BUNDLED_GROUP])
  })

  it('carries an existing opt-in across, leaving every group on', () => {
    expect(migrateDisabledGroups('true')).toEqual([])
  })
})

describe('group enablement', () => {
  const withStorage = (entries: Record<string, string> = {}) => {
    const store = new Map<string, string>(Object.entries(entries))
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, next: string) => store.set(key, next),
        removeItem: (key: string) => store.delete(key)
      }
    })
    return store
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats a group nobody has switched off as on', () => {
    withStorage({ [DISABLED_GROUPS_KEY]: '[]' })
    expect(isGroupEnabled('Long form')).toBe(true)
  })

  it('persists a group being switched off and back on', () => {
    const store = withStorage({ [DISABLED_GROUPS_KEY]: '[]' })

    setGroupEnabled('Long form', false)
    expect(store.get(DISABLED_GROUPS_KEY)).toBe('["Long form"]')
    expect(isGroupEnabled('Long form')).toBe(false)

    setGroupEnabled('Long form', true)
    expect(isGroupEnabled('Long form')).toBe(true)
  })

  it('migrates a browser that only ever stored the bundled opt-in', () => {
    const store = withStorage({ [BUNDLED_EXAMPLES_ENABLED_KEY]: 'true' })
    expect(isGroupEnabled(BUNDLED_GROUP)).toBe(true)
    // The migration is written once, so the old key stops being consulted
    expect(store.get(DISABLED_GROUPS_KEY)).toBe('[]')
  })

  it('keeps bundled examples out of the retrieval set by default', () => {
    withStorage()
    expect(getEnabledExamples().some(example => example.source === 'bundled')).toBe(false)
  })

  it('includes bundled examples once their group is switched on', () => {
    withStorage({ [DISABLED_GROUPS_KEY]: '[]' })
    expect(getEnabledExamples().some(example => example.source === 'bundled')).toBe(true)
  })

  it('excludes a switched-off group from the retrieval set', () => {
    withStorage({ [DISABLED_GROUPS_KEY]: JSON.stringify([BUNDLED_GROUP]) })
    expect(getEnabledExamples().some(example => example.group === BUNDLED_GROUP)).toBe(false)
  })
})
