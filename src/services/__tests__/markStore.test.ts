import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MARKS_STORAGE_VERSION,
  NO_MARKS,
  findingKey,
  loadMarks,
  pruneMarks,
  readBodySelection,
  saveMarks,
  type ReaderFlag
} from '../markStore'

// The tests run in node, so storage is stood in for. Everything below is about
// what the module does with what storage hands back, which is the part that has
// to survive a hand-edited file.
const store = new Map<string, string>()

// Enumeration is part of the Storage API the pruning walk uses, so the stand-in
// answers length and key(i) the way a browser does: by insertion order, with
// the list shifting under a removal.
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
  get length() {
    return store.size
  },
  key: (index: number) => [...store.keys()][index] ?? null
}

const flag = (overrides: Partial<ReaderFlag> = {}): ReaderFlag => ({
  id: 'flag-1',
  section: 'Settling',
  anchor: { quote: 'the breath moves on its own', before: 'Notice how ', after: ' now.', occurrence: 0 },
  revisions: 0,
  label: 'Too abstract',
  createdAt: 1000,
  ...overrides
})

describe('markStore', () => {
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('window', { localStorage: fakeStorage })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('what the browser remembers for one script', () => {
    it('reads back what it wrote', () => {
      saveMarks('script-a', { flags: [flag()], dismissed: ['style-key'], spent: ['spent-key'] })

      expect(loadMarks('script-a'))
        .toEqual({ flags: [flag()], dismissed: ['style-key'], spent: ['spent-key'] })
    })

    it('keeps a script that was never marked empty', () => {
      expect(loadMarks('never-marked')).toEqual(NO_MARKS)
    })

    // M3: a mark is about a body, and a duplicate's bodies are about to
    // diverge, so the copy must not inherit the original's marks. Keying on
    // the script id is the whole of the mechanism.
    it('does not hand one script the marks of another', () => {
      saveMarks('script-a', { flags: [flag()], dismissed: ['style-key'], spent: [] })

      expect(loadMarks('script-b')).toEqual(NO_MARKS)
    })

    // A finding the reader paid a rewrite for is remembered apart from one
    // they dismissed: only the dismissed can be restored, so lumping them
    // together would offer to re-buy a rewrite that already happened.
    it('keeps what was spent apart from what was dismissed', () => {
      saveMarks('script-a', { flags: [], dismissed: ['dismissed-key'], spent: ['spent-key'] })

      const loaded = loadMarks('script-a')
      expect(loaded.dismissed).toEqual(['dismissed-key'])
      expect(loaded.spent).toEqual(['spent-key'])
    })

    it('remembers a script whose only mark is a spend', () => {
      saveMarks('script-a', { flags: [], dismissed: [], spent: ['spent-key'] })

      expect(loadMarks('script-a').spent).toEqual(['spent-key'])
    })

    it('leaves no key behind when the last mark goes', () => {
      saveMarks('script-a', { flags: [flag()], dismissed: [], spent: [] })
      saveMarks('script-a', NO_MARKS)

      expect(store.has('marks.script-a')).toBe(false)
      expect(loadMarks('script-a')).toEqual(NO_MARKS)
    })
  })

  describe('storage nobody promised was well formed', () => {
    it('drops a flag with no passage to pin', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: [flag(), { ...flag({ id: 'flag-2' }), anchor: { quote: '', before: '', after: '', occurrence: 0 } }],
        dismissed: []
      }))

      expect(loadMarks('script-a').flags.map(stored => stored.id)).toEqual(['flag-1'])
    })

    it('drops a flag whose occurrence is not a whole number', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: [{ ...flag(), anchor: { ...flag().anchor, occurrence: 1.5 } }],
        dismissed: []
      }))

      expect(loadMarks('script-a').flags).toEqual([])
    })

    // Written before spending was held apart from dismissal. Nothing was
    // spent, which is not a reason to throw the reader's flags away.
    it('reads a record that predates spending as having spent nothing', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: [flag()],
        dismissed: ['style-key']
      }))

      expect(loadMarks('script-a')).toEqual({ flags: [flag()], dismissed: ['style-key'], spent: [] })
    })

    it('drops spends that are not keys', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: [],
        dismissed: [],
        spent: ['spent-key', 7, null]
      }))

      expect(loadMarks('script-a').spent).toEqual(['spent-key'])
    })

    it('drops dismissals that are not keys', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: [],
        dismissed: ['style-key', 7, null]
      }))

      expect(loadMarks('script-a').dismissed).toEqual(['style-key'])
    })

    it('rebuilds a flag rather than passing it through, so nothing extra survives', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: [{ ...flag(), smuggled: 'value', note: '' }],
        dismissed: []
      }))

      expect(loadMarks('script-a').flags[0]).toEqual(flag())
      expect(Object.keys(loadMarks('script-a').flags[0] ?? {})).not.toContain('smuggled')
    })

    it('discards a record written under another version rather than reading it', () => {
      store.set('marks.script-a', JSON.stringify({
        version: MARKS_STORAGE_VERSION + 1,
        flags: [flag()],
        dismissed: []
      }))

      expect(loadMarks('script-a')).toEqual(NO_MARKS)
    })

    it('answers unreadable storage with no marks rather than throwing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      store.set('marks.script-a', 'not json at all')

      expect(loadMarks('script-a')).toEqual(NO_MARKS)
      expect(warn).toHaveBeenCalled()
    })

    it('survives storage that refuses to be written to', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubGlobal('window', {
        localStorage: {
          ...fakeStorage,
          setItem: () => {
            throw new Error('quota exceeded')
          }
        }
      })

      expect(() => saveMarks('script-a', { flags: [flag()], dismissed: [], spent: [] }))
        .not.toThrow()
      expect(warn).toHaveBeenCalled()
    })

    it('answers with no marks where there is no window at all', () => {
      vi.stubGlobal('window', undefined)

      expect(loadMarks('script-a')).toEqual(NO_MARKS)
      expect(() => saveMarks('script-a', { flags: [flag()], dismissed: [], spent: [] }))
        .not.toThrow()
    })
  })

  // M9: marks are keyed by script id and nothing else refers to them, so a
  // deleted script leaves its key behind for good unless the library says
  // which scripts are still there.
  describe('forgetting the marks of scripts that are gone', () => {
    it('removes the marks of a script the library no longer lists', () => {
      saveMarks('script-a', { flags: [flag()], dismissed: [], spent: [] })
      saveMarks('script-b', { flags: [flag({ id: 'flag-2' })], dismissed: [], spent: [] })

      expect(pruneMarks(['script-b'])).toEqual(['script-a'])
      expect(store.has('marks.script-a')).toBe(false)
      expect(loadMarks('script-b').flags.map(stored => stored.id)).toEqual(['flag-2'])
    })

    // Removing while walking by index moves every later key down one, which
    // would skip the key after each removal.
    it('removes every stale script, not every other one', () => {
      saveMarks('script-a', { flags: [flag()], dismissed: [], spent: [] })
      saveMarks('script-b', { flags: [flag()], dismissed: [], spent: [] })
      saveMarks('script-c', { flags: [flag()], dismissed: [], spent: [] })

      expect(pruneMarks([]).sort()).toEqual(['script-a', 'script-b', 'script-c'])
      expect([...store.keys()].filter(key => key.startsWith('marks.'))).toEqual([])
    })

    it('leaves everything that is not a marks key alone', () => {
      store.set('script_script-a', 'the script itself')
      saveMarks('script-a', { flags: [flag()], dismissed: [], spent: [] })

      pruneMarks([])

      expect(store.get('script_script-a')).toBe('the script itself')
    })

    it('forgets nothing where there is no window at all', () => {
      vi.stubGlobal('window', undefined)

      expect(pruneMarks([])).toEqual([])
    })
  })

  describe('naming a finding', () => {
    const finding = {
      section: 'Settling',
      reason: 'The image is borrowed from the opening',
      spans: [{ quote: 'the breath moves on its own', before: '', after: '', occurrence: 0 }]
    }

    it('names the same finding the same way twice', () => {
      expect(findingKey(finding, 'style')).toBe(findingKey({ ...finding }, 'style'))
    })

    it('separates findings that differ only in stage', () => {
      expect(findingKey(finding, 'style')).not.toBe(findingKey(finding, 'review'))
    })

    it('separates findings that differ only in reason', () => {
      expect(findingKey(finding, 'style'))
        .not.toBe(findingKey({ ...finding, reason: 'Something else' }, 'style'))
    })

    // The key is built from the record, not from where the passage sits now,
    // so a dismissal outlives the section being rewritten under it.
    it('names a finding the same way after its section has been rewritten', () => {
      const rewritten = {
        ...finding,
        spans: [{ ...finding.spans[0], before: 'entirely different words ', after: ' and more' }]
      }

      expect(findingKey(finding, 'style')).toBe(findingKey(rewritten, 'style'))
    })

    it('names a finding that quoted nothing', () => {
      expect(findingKey({ section: 'Settling', reason: 'Not written yet' }, 'outline'))
        .not.toBe('')
    })

    // Two findings whose fields run together at the join would otherwise share
    // one key, and dismissing one would silently hide the other.
    it('does not let two findings run together into one key', () => {
      expect(findingKey({ section: 'Ab', reason: 'c' }, 'style'))
        .not.toBe(findingKey({ section: 'A', reason: 'bc' }, 'style'))
    })
  })

  describe('reading what the reader selected', () => {
    const selectionOf = (
      text: string,
      options: { collapsed?: boolean; ranges?: number; inside?: boolean } = {}
    ) => {
      const contained = options.inside !== false
      const root = { contains: () => contained } as unknown as HTMLElement
      vi.stubGlobal('window', {
        localStorage: fakeStorage,
        getSelection: () => ({
          isCollapsed: options.collapsed ?? false,
          rangeCount: options.ranges ?? 1,
          getRangeAt: () => ({ commonAncestorContainer: {} }),
          toString: () => text
        })
      })
      return readBodySelection(root)
    }

    it('reads the selected text', () => {
      expect(selectionOf('the breath moves on its own')).toBe('the breath moves on its own')
    })

    it('refuses a caret that selected nothing', () => {
      expect(selectionOf('', { collapsed: true })).toBeNull()
      expect(selectionOf('the breath', { ranges: 0 })).toBeNull()
    })

    it('refuses a selection of whitespace', () => {
      expect(selectionOf('  \n  ')).toBeNull()
    })

    // A drag that began in the conversation panel and ended in the script must
    // not be pinned to words it does not name.
    it('refuses a selection that reaches outside the element that asked', () => {
      expect(selectionOf('the breath moves on its own', { inside: false })).toBeNull()
    })

    it('answers null where there is no selection API', () => {
      vi.stubGlobal('window', { localStorage: fakeStorage })

      expect(readBodySelection({ contains: () => true } as unknown as HTMLElement)).toBeNull()
    })
  })
})
