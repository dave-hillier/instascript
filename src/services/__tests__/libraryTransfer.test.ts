import { describe, it, expect } from 'vitest'
import {
  serializeLibraryExport,
  parseLibraryExport,
  mergeLibrary,
  LIBRARY_EXPORT_FORMAT
} from '../libraryTransfer'
import type { Script } from '../../types/script'
import type { RawConversation } from '../../types/conversation'

const makeScript = (id: string): Script => ({
  id,
  title: `Script ${id}`,
  content: 'Some content',
  createdAt: '2026-07-25T00:00:00.000Z',
  isArchived: false
})

const makeConversation = (id: string, scriptId: string): RawConversation => ({
  id,
  scriptId,
  generations: [
    {
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'write a script' }
      ],
      response: '## Induction\nBreathe.',
      timestamp: 1700000000000
    }
  ],
  createdAt: 1700000000000,
  updatedAt: 1700000000000
})

describe('serializeLibraryExport and parseLibraryExport', () => {
  it('round-trips scripts and conversations', () => {
    const json = serializeLibraryExport(
      [makeScript('s1')],
      [makeConversation('c1', 's1')]
    )

    const parsed = parseLibraryExport(json)

    expect(parsed.format).toBe(LIBRARY_EXPORT_FORMAT)
    expect(parsed.scripts).toHaveLength(1)
    expect(parsed.scripts[0].id).toBe('s1')
    expect(parsed.scripts[0].title).toBe('Script s1')
    expect(parsed.conversations).toHaveLength(1)
    expect(parsed.conversations[0].generations[0].response).toContain('Induction')
  })

  it('rejects a file that is not JSON', () => {
    expect(() => parseLibraryExport('not json at all')).toThrow('not valid JSON')
  })

  it('rejects JSON that is not a library export', () => {
    expect(() => parseLibraryExport('{"foo": 1}')).toThrow('not an InstaScript library export')
    expect(() => parseLibraryExport('[1,2,3]')).toThrow('not a library export')
  })

  it('rejects an export whose lists are missing', () => {
    const json = JSON.stringify({ format: LIBRARY_EXPORT_FORMAT, scripts: [] })
    expect(() => parseLibraryExport(json)).toThrow('missing its scripts or conversations')
  })

  it('rejects scripts without an id and conversations without a scriptId', () => {
    const missingScriptId = JSON.stringify({
      format: LIBRARY_EXPORT_FORMAT,
      scripts: [{ title: 'No id' }],
      conversations: []
    })
    expect(() => parseLibraryExport(missingScriptId)).toThrow('missing an id')

    const missingConversationScript = JSON.stringify({
      format: LIBRARY_EXPORT_FORMAT,
      scripts: [],
      conversations: [{ id: 'c1', generations: [] }]
    })
    expect(() => parseLibraryExport(missingConversationScript)).toThrow('missing its scriptId')
  })

  it('round-trips example selection counts (story 8.11)', () => {
    const json = serializeLibraryExport(
      [makeScript('s1')],
      [makeConversation('c1', 's1')],
      { example_a: 3, example_b: 1 }
    )

    const parsed = parseLibraryExport(json)

    expect(parsed.exampleSelectionCounts).toEqual({ example_a: 3, example_b: 1 })
  })

  it('defaults selection counts to empty for older exports without them', () => {
    const json = JSON.stringify({
      format: LIBRARY_EXPORT_FORMAT,
      scripts: [],
      conversations: []
    })

    expect(parseLibraryExport(json).exampleSelectionCounts).toEqual({})
  })

  it('drops malformed selection count entries instead of failing', () => {
    const json = JSON.stringify({
      format: LIBRARY_EXPORT_FORMAT,
      scripts: [],
      conversations: [],
      exampleSelectionCounts: {
        example_ok: 2,
        example_negative: -1,
        example_string: 'five',
        example_nan: null
      }
    })

    expect(parseLibraryExport(json).exampleSelectionCounts).toEqual({ example_ok: 2 })
  })

  it('round-trips the exampleIds recorded on a generation', () => {
    const conversation = makeConversation('c1', 's1')
    conversation.generations[0].exampleIds = ['example_a', 'bundled_b']

    const parsed = parseLibraryExport(serializeLibraryExport([], [conversation]))

    expect(parsed.conversations[0].generations[0].exampleIds).toEqual(['example_a', 'bundled_b'])
  })

  it('fills defaults for optional script fields', () => {
    const json = JSON.stringify({
      format: LIBRARY_EXPORT_FORMAT,
      scripts: [{ id: 's1', title: 'Bare' }],
      conversations: []
    })

    const parsed = parseLibraryExport(json)

    expect(parsed.scripts[0].content).toBe('')
    expect(parsed.scripts[0].isArchived).toBe(false)
  })
})

describe('mergeLibrary', () => {
  it('imports everything into an empty library', () => {
    const imported = parseLibraryExport(
      serializeLibraryExport(
        [makeScript('s1'), makeScript('s2')],
        [makeConversation('c1', 's1')]
      )
    )

    const result = mergeLibrary(imported, { scriptIds: [], conversations: [] })

    expect(result.scriptsImported).toBe(2)
    expect(result.scriptsSkipped).toBe(0)
    expect(result.conversationsImported).toBe(1)
    expect(result.conversationsSkipped).toBe(0)
    expect(result.newScripts.map(s => s.id)).toEqual(['s1', 's2'])
  })

  it('skips scripts and conversations whose ids already exist', () => {
    const imported = parseLibraryExport(
      serializeLibraryExport(
        [makeScript('s1'), makeScript('s2')],
        [makeConversation('c1', 's1'), makeConversation('c2', 's2')]
      )
    )

    const result = mergeLibrary(imported, {
      scriptIds: ['s1'],
      conversations: [{ id: 'c1', scriptId: 's1' }]
    })

    expect(result.scriptsImported).toBe(1)
    expect(result.scriptsSkipped).toBe(1)
    expect(result.newScripts.map(s => s.id)).toEqual(['s2'])
    expect(result.conversationsImported).toBe(1)
    expect(result.conversationsSkipped).toBe(1)
    expect(result.newConversations.map(c => c.id)).toEqual(['c2'])
  })

  it('skips a conversation whose script already has one, since storage is keyed by scriptId', () => {
    const imported = parseLibraryExport(
      serializeLibraryExport([], [makeConversation('c-new', 's1')])
    )

    const result = mergeLibrary(imported, {
      scriptIds: ['s1'],
      conversations: [{ id: 'c-existing', scriptId: 's1' }]
    })

    expect(result.conversationsImported).toBe(0)
    expect(result.conversationsSkipped).toBe(1)
  })

  it('collapses duplicates within the imported file itself', () => {
    const imported = parseLibraryExport(
      serializeLibraryExport(
        [makeScript('s1'), makeScript('s1')],
        [makeConversation('c1', 's1'), makeConversation('c1', 's1')]
      )
    )

    const result = mergeLibrary(imported, { scriptIds: [], conversations: [] })

    expect(result.scriptsImported).toBe(1)
    expect(result.scriptsSkipped).toBe(1)
    expect(result.conversationsImported).toBe(1)
    expect(result.conversationsSkipped).toBe(1)
  })
})

// The requested length decides what every later rewrite, refinement and review
// aims at, so losing it in transfer silently replans the script at the default
describe('the requested length survives a library round trip', () => {
  it('carries targetMinutes through export and import', () => {
    const script: Script = { ...makeScript('s1'), targetMinutes: 60 }
    const serialized = serializeLibraryExport([script], [makeConversation('c1', 's1')])

    const parsed = parseLibraryExport(serialized)

    expect(parsed.scripts[0].targetMinutes).toBe(60)
  })

  it('leaves targetMinutes unset when the export has none', () => {
    const serialized = serializeLibraryExport([makeScript('s1')], [])

    expect(parseLibraryExport(serialized).scripts[0].targetMinutes).toBeUndefined()
  })
})
