import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  areBundledExamplesEnabled,
  setBundledExamplesEnabled,
  getEnabledExamples,
  isImportableExampleFile,
  BUNDLED_EXAMPLES_ENABLED_KEY,
  parseExampleMarkdown,
  serializeExampleToMarkdown,
  parseTags,
  parseSelectionCounts,
  sanitizeSelectionCounts,
  incrementSelectionCounts,
  mergeSelectionCounts,
  normalizeFolderName,
  exampleFolder,
  folderFromImportPath,
  listExampleFolders,
  resolveActiveFolder,
  resolveImportFolder,
  parseFolderList,
  createExampleFolder,
  renameExampleFolder,
  deleteExampleFolder,
  moveExampleToFolder,
  getDeclaredFolders,
  getExampleFolders,
  getActiveExampleFolder,
  getUserExamples,
  ACTIVE_EXAMPLE_FOLDER_KEY,
  EXAMPLE_FOLDERS_KEY,
  UNFILED_FOLDER
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

  it('round-trips the library script an example was saved from (story 8.16)', () => {
    const record: ExampleRecord = {
      id: 'example_from_script',
      title: 'From the library',
      tags: [],
      content: 'Body text.',
      source: 'user',
      createdAt: 1,
      sourceScriptId: 'script_1_abc'
    }

    const parsed = parseExampleMarkdown(serializeExampleToMarkdown(record), 'fallback')
    expect(parsed.sourceScriptId).toBe('script_1_abc')
  })

  it('omits the source script key for an imported example', () => {
    const serialized = serializeExampleToMarkdown({
      id: 'example_imported',
      title: 'Imported',
      tags: [],
      content: 'Body text.',
      source: 'user',
      createdAt: 1
    })

    expect(serialized).not.toContain('sourceScriptId')
    expect(parseExampleMarkdown(serialized, 'fallback').sourceScriptId).toBeUndefined()
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

describe('example folders', () => {
  const example = (overrides: Partial<ExampleRecord>): ExampleRecord => ({
    id: 'example_1',
    title: 'Example',
    tags: [],
    content: 'Body.',
    source: 'user',
    ...overrides
  })

  it('normalizes a folder name to what is stored and compared', () => {
    expect(normalizeFolderName('  Deep   Sleep  ')).toBe('Deep Sleep')
    expect(normalizeFolderName('scripts/sleep')).toBe('scripts sleep')
    expect(normalizeFolderName('   ')).toBe('')
  })

  it('caps a folder name rather than storing an essay', () => {
    expect(normalizeFolderName('x'.repeat(200))).toHaveLength(64)
  })

  it('treats an example with no folder as unfiled', () => {
    expect(exampleFolder(example({}))).toBe(UNFILED_FOLDER)
    expect(exampleFolder(example({ folder: '  ' }))).toBe(UNFILED_FOLDER)
    expect(exampleFolder(example({ folder: ' Sleep ' }))).toBe('Sleep')
  })

  it('files an imported file under the directory it sits in', () => {
    expect(folderFromImportPath('Corpus/sleep/deep-rest.md')).toBe('sleep')
    expect(folderFromImportPath('Sleep/deep-rest.md')).toBe('Sleep')
  })

  it('leaves a file chosen on its own unfiled', () => {
    expect(folderFromImportPath('deep-rest.md')).toBe(UNFILED_FOLDER)
  })

  it('lists folders alphabetically with the unfiled catch-all last', () => {
    const folders = listExampleFolders([
      example({ id: 'a', folder: 'sleep' }),
      example({ id: 'b' }),
      example({ id: 'c', folder: 'Anxiety' }),
      example({ id: 'd', folder: 'sleep' })
    ])
    expect(folders).toEqual(['Anxiety', 'sleep', UNFILED_FOLDER])
  })

  it('keeps a stored folder that still exists', () => {
    expect(resolveActiveFolder(['Sleep', UNFILED_FOLDER], 'Sleep')).toBe('Sleep')
  })

  it('starts unfiled, so a corpus imported before folders existed still grounds generation', () => {
    expect(resolveActiveFolder([UNFILED_FOLDER], null)).toBe(UNFILED_FOLDER)
  })

  it('falls back to a folder that exists when the stored one is deleted', () => {
    expect(resolveActiveFolder(['Sleep', UNFILED_FOLDER], 'Anxiety')).toBe(UNFILED_FOLDER)
    expect(resolveActiveFolder(['Sleep'], 'Anxiety')).toBe('Sleep')
  })

  it('resolves to unfiled when there are no examples at all', () => {
    expect(resolveActiveFolder([], null)).toBe(UNFILED_FOLDER)
    expect(resolveActiveFolder([], 'Sleep')).toBe(UNFILED_FOLDER)
  })

  it('round-trips a folder through serialization', () => {
    const serialized = serializeExampleToMarkdown(
      example({ folder: 'Deep Sleep', createdAt: 1 })
    )
    expect(parseExampleMarkdown(serialized, 'fallback').folder).toBe('Deep Sleep')
  })

  it('keeps a folder that has been made but not filled, and lists it in order', () => {
    const folders = listExampleFolders(
      [example({ id: 'a', folder: 'sleep' }), example({ id: 'b' })],
      ['Anxiety', 'sleep']
    )
    expect(folders).toEqual(['Anxiety', 'sleep', UNFILED_FOLDER])
  })

  it('does not invent an unfiled folder when nothing is unfiled', () => {
    expect(listExampleFolders([example({ id: 'a', folder: 'sleep' })], ['Focus'])).toEqual([
      'Focus',
      'sleep'
    ])
  })

  it('reads a stored folder list, dropping malformed and implicit entries', () => {
    expect(parseFolderList('["Sleep", "  ", 7, "Sleep", "Unfiled", "Focus"]')).toEqual([
      'Sleep',
      'Focus'
    ])
    expect(parseFolderList(null)).toEqual([])
    expect(parseFolderList('not json')).toEqual([])
    expect(parseFolderList('{"a":1}')).toEqual([])
  })

  it('sends an import to the chosen folder whatever the file says', () => {
    expect(
      resolveImportFolder('Corpus/sleep/rest.md', 'Anxiety', {
        folder: 'Chosen',
        fallback: 'Active'
      })
    ).toBe('Chosen')
  })

  it('falls back through path, front matter, then the folder in use', () => {
    expect(resolveImportFolder('Corpus/sleep/rest.md', 'Anxiety', { fallback: 'Active' })).toBe(
      'sleep'
    )
    expect(resolveImportFolder('rest.md', 'Anxiety', { fallback: 'Active' })).toBe('Anxiety')
    expect(resolveImportFolder('rest.md', undefined, { fallback: 'Active' })).toBe('Active')
    expect(resolveImportFolder('rest.md', undefined)).toBe(UNFILED_FOLDER)
  })

  it('writes no folder key for an unfiled example, so old files are unchanged', () => {
    expect(serializeExampleToMarkdown(example({ createdAt: 1 }))).not.toContain('folder')
    expect(
      serializeExampleToMarkdown(example({ folder: UNFILED_FOLDER, createdAt: 1 }))
    ).not.toContain('folder')
  })
})

describe('parseTags', () => {
  it('splits, trims, lowercases and drops empties', () => {
    expect(parseTags(' Sleep, CALM ,, rest ')).toEqual(['sleep', 'calm', 'rest'])
  })

  it('returns an empty list for blank input', () => {
    expect(parseTags('  ')).toEqual([])
  })

  it('collapses typed standard tags onto the vocabulary, leading (story 8.17)', () => {
    expect(parseTags('sleep, NSFW, for her, post hypnotic')).toEqual([
      'explicit',
      'female subject',
      'post-hypnotic',
      'sleep'
    ])
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

describe('one folder at a time grounds generation', () => {
  // Stored examples are read by enumerating the storage keys, so the stub
  // exposes them as own enumerable properties the way localStorage does
  const withStoredExamples = (entries: Record<string, string>) => {
    const store = new Map(Object.entries(entries))
    const storage: Record<string, unknown> = {}
    Object.defineProperties(storage, {
      getItem: { value: (key: string) => store.get(key) ?? null },
      setItem: { value: (key: string, value: string) => store.set(key, value) },
      removeItem: { value: (key: string) => store.delete(key) }
    })
    for (const [key, value] of store) {
      Object.defineProperty(storage, key, { value, enumerable: true })
    }
    vi.stubGlobal('window', { localStorage: storage })
  }

  const stored = (title: string, folder?: string) =>
    serializeExampleToMarkdown({
      id: 'ignored',
      title,
      tags: [],
      content: `${title} body.`,
      source: 'user',
      folder,
      createdAt: 1
    })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retrieves only the active folder', () => {
    withStoredExamples({
      example_1: stored('Deep Rest', 'Sleep'),
      example_2: stored('Calm Breath', 'Anxiety'),
      [ACTIVE_EXAMPLE_FOLDER_KEY]: 'Sleep'
    })

    expect(getEnabledExamples().map(example => example.title)).toEqual(['Deep Rest'])
  })

  it('keeps grounding a corpus imported before folders existed', () => {
    withStoredExamples({
      example_1: stored('Legacy One'),
      example_2: stored('Legacy Two')
    })

    expect(getEnabledExamples().map(example => example.title)).toEqual([
      'Legacy One',
      'Legacy Two'
    ])
  })

  it('falls back to a folder that exists when the active one was deleted', () => {
    withStoredExamples({
      example_1: stored('Calm Breath', 'Anxiety'),
      [ACTIVE_EXAMPLE_FOLDER_KEY]: 'Sleep'
    })

    expect(getEnabledExamples().map(example => example.title)).toEqual(['Calm Breath'])
  })

  it('makes an empty folder that exists before anything is filed in it', () => {
    withStoredExamples({ example_1: stored('Calm Breath', 'Anxiety') })

    expect(createExampleFolder('  Deep  Sleep ')).toBe('Deep Sleep')
    expect(getDeclaredFolders()).toContain('Deep Sleep')
    expect(getExampleFolders()).toEqual(['Anxiety', 'Deep Sleep'])
  })

  it('refuses to make a folder out of nothing, or a second unfiled', () => {
    withStoredExamples({})

    expect(createExampleFolder('   ')).toBe('')
    expect(createExampleFolder(UNFILED_FOLDER)).toBe('')
    expect(getDeclaredFolders()).toEqual([])
  })

  it('keeps a folder that has been emptied by moving its last example out', () => {
    withStoredExamples({ example_1: stored('Calm Breath', 'Anxiety') })

    moveExampleToFolder('example_1', 'Sleep')

    expect(getExampleFolders()).toEqual(['Anxiety', 'Sleep'])
  })

  it('renames a folder, taking its examples and the active setting with it', () => {
    withStoredExamples({
      example_1: stored('Deep Rest', 'Sleep'),
      example_2: stored('Night Drift', 'Sleep'),
      example_3: stored('Calm Breath', 'Anxiety'),
      [ACTIVE_EXAMPLE_FOLDER_KEY]: 'Sleep'
    })

    expect(renameExampleFolder('Sleep', 'Deep Sleep')).toBe('Deep Sleep')
    expect(getExampleFolders()).toEqual(['Anxiety', 'Deep Sleep'])
    expect(getActiveExampleFolder()).toBe('Deep Sleep')
    expect(getEnabledExamples().map(example => example.title)).toEqual([
      'Deep Rest',
      'Night Drift'
    ])
  })

  it('merges when renamed onto a folder that already exists', () => {
    withStoredExamples({
      example_1: stored('Deep Rest', 'Sleep'),
      example_2: stored('Calm Breath', 'Anxiety'),
      [ACTIVE_EXAMPLE_FOLDER_KEY]: 'Anxiety'
    })

    renameExampleFolder('Sleep', 'Anxiety')

    expect(getExampleFolders()).toEqual(['Anxiety'])
    expect(getEnabledExamples().map(example => example.title)).toEqual([
      'Deep Rest',
      'Calm Breath'
    ])
  })

  it('files loose examples under a name when the unfiled folder is renamed', () => {
    withStoredExamples({ example_1: stored('An Old Import') })

    renameExampleFolder(UNFILED_FOLDER, 'My Scripts')

    expect(getExampleFolders()).toEqual(['My Scripts'])
    expect(getUserExamples()[0].folder).toBe('My Scripts')
  })

  it('leaves a rename to nothing alone', () => {
    withStoredExamples({ example_1: stored('Deep Rest', 'Sleep') })

    expect(renameExampleFolder('Sleep', '   ')).toBe('Sleep')
    expect(getExampleFolders()).toEqual(['Sleep'])
  })

  it('deleting a folder takes its examples and the folder itself', () => {
    withStoredExamples({
      example_1: stored('Deep Rest', 'Sleep'),
      example_2: stored('Calm Breath', 'Anxiety'),
      [EXAMPLE_FOLDERS_KEY]: JSON.stringify(['Sleep', 'Anxiety'])
    })

    expect(deleteExampleFolder('Sleep')).toBe(1)
    expect(getExampleFolders()).toEqual(['Anxiety'])
    expect(getUserExamples().map(example => example.title)).toEqual(['Calm Breath'])
  })

  it('deletes an empty folder without touching anything else', () => {
    withStoredExamples({
      example_1: stored('Calm Breath', 'Anxiety'),
      [EXAMPLE_FOLDERS_KEY]: JSON.stringify(['Anxiety', 'Focus'])
    })

    expect(deleteExampleFolder('Focus')).toBe(0)
    expect(getExampleFolders()).toEqual(['Anxiety'])
    expect(getUserExamples()).toHaveLength(1)
  })
})

describe('bundled corpus opt-in', () => {
  const withStoredValue = (value: string | null) => {
    const store = new Map<string, string>()
    if (value !== null) store.set(BUNDLED_EXAMPLES_ENABLED_KEY, value)
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

  it('defaults to disabled when nothing is stored', () => {
    withStoredValue(null)
    expect(areBundledExamplesEnabled()).toBe(false)
  })

  it('reads a stored opt-in', () => {
    withStoredValue('true')
    expect(areBundledExamplesEnabled()).toBe(true)
  })

  it('reads a stored opt-out', () => {
    withStoredValue('false')
    expect(areBundledExamplesEnabled()).toBe(false)
  })

  it('treats an unreadable stored value as disabled', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    withStoredValue('not json')
    expect(areBundledExamplesEnabled()).toBe(false)
    vi.restoreAllMocks()
  })

  it('persists the setting in both directions so it survives a reload', () => {
    const store = withStoredValue(null)

    setBundledExamplesEnabled(true)
    expect(store.get(BUNDLED_EXAMPLES_ENABLED_KEY)).toBe('true')
    expect(areBundledExamplesEnabled()).toBe(true)

    setBundledExamplesEnabled(false)
    expect(store.get(BUNDLED_EXAMPLES_ENABLED_KEY)).toBe('false')
    expect(areBundledExamplesEnabled()).toBe(false)
  })

  it('keeps bundled examples out of the retrieval set when disabled', () => {
    withStoredValue('false')
    expect(getEnabledExamples().some(example => example.source === 'bundled')).toBe(false)
  })

  it('keeps bundled examples out of the retrieval set by default', () => {
    withStoredValue(null)
    expect(getEnabledExamples().some(example => example.source === 'bundled')).toBe(false)
  })

  it('includes bundled examples in the retrieval set when enabled', () => {
    withStoredValue('true')
    expect(getEnabledExamples().some(example => example.source === 'bundled')).toBe(true)
  })
})
