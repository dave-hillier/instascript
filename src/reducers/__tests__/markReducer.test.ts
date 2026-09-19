import { describe, it, expect } from 'vitest'
import { NO_MARK_STATE, markReducer, marksToStore, type MarkState } from '../markReducer'
import type { ReaderFlag } from '../../services/markStore'

const flag = (overrides: Partial<ReaderFlag> = {}): ReaderFlag => ({
  id: 'flag-1',
  section: 'Settling',
  anchor: { quote: 'the breath moves on its own', before: '', after: '', occurrence: 0 },
  revisions: 0,
  label: 'Flagged passage',
  createdAt: 1000,
  ...overrides
})

const loaded = (marks: Partial<MarkState> = {}): MarkState => ({
  scriptId: 'script-a',
  flags: [],
  dismissed: [],
  spent: [],
  ...marks
})

describe('markReducer', () => {
  describe('loading a script', () => {
    it('takes on the marks stored for the script it names', () => {
      const state = markReducer(NO_MARK_STATE, {
        type: 'MARKS_LOADED',
        scriptId: 'script-a',
        marks: { flags: [flag()], dismissed: ['style-key'], spent: ['spent-key'] }
      })

      expect(state).toEqual({
        scriptId: 'script-a',
        flags: [flag()],
        dismissed: ['style-key'],
        spent: ['spent-key']
      })
    })

    // Navigating to another script must not leave the previous script's marks
    // in state, where the saving effect would file them under the new id.
    it('replaces the previous script whole rather than merging', () => {
      const state = markReducer(
        loaded({ flags: [flag()], dismissed: ['style-key'], spent: ['spent-key'] }),
        { type: 'MARKS_LOADED', scriptId: 'script-b', marks: { flags: [], dismissed: [], spent: [] } }
      )

      expect(state).toEqual({ scriptId: 'script-b', flags: [], dismissed: [], spent: [] })
    })
  })

  describe('the reader marking a passage', () => {
    it('keeps the flag', () => {
      const state = markReducer(loaded(), { type: 'PASSAGE_FLAGGED', flag: flag() })

      expect(state.flags).toEqual([flag()])
    })

    it('keeps flags in the order they were made', () => {
      const first = markReducer(loaded(), { type: 'PASSAGE_FLAGGED', flag: flag() })
      const second = markReducer(first, {
        type: 'PASSAGE_FLAGGED',
        flag: flag({
          id: 'flag-2',
          anchor: { quote: 'without any help from you', before: '', after: '', occurrence: 0 }
        })
      })

      expect(second.flags.map(stored => stored.id)).toEqual(['flag-1', 'flag-2'])
    })

    // Selecting a run of words, clicking away and selecting them again is an
    // ordinary thing to do while reading; it should not leave a pile of
    // identical marks in the panel.
    it('does not record the same passage twice under a second id', () => {
      const first = markReducer(loaded(), { type: 'PASSAGE_FLAGGED', flag: flag() })
      const again = markReducer(first, {
        type: 'PASSAGE_FLAGGED',
        flag: flag({ id: 'flag-2', label: 'Marked passage' })
      })

      expect(again).toBe(first)
    })

    it('keeps a flag on a different passage in the same section', () => {
      const first = markReducer(loaded(), { type: 'PASSAGE_FLAGGED', flag: flag() })
      const second = markReducer(first, {
        type: 'PASSAGE_FLAGGED',
        flag: flag({
          id: 'flag-2',
          anchor: { quote: 'without any help from you', before: '', after: '', occurrence: 0 }
        })
      })

      expect(second.flags).toHaveLength(2)
    })

    it('does not record the same flag twice', () => {
      const first = markReducer(loaded(), { type: 'PASSAGE_FLAGGED', flag: flag() })
      const again = markReducer(first, { type: 'PASSAGE_FLAGGED', flag: flag() })

      expect(again).toBe(first)
    })
  })

  describe('a flag being the reader\'s own', () => {
    it('takes a new label', () => {
      const state = markReducer(
        loaded({ flags: [flag()] }),
        { type: 'FLAG_RELABELLED', id: 'flag-1', label: 'Too abstract' }
      )

      expect(state.flags[0]?.label).toBe('Too abstract')
    })

    it('takes a note', () => {
      const state = markReducer(
        loaded({ flags: [flag()] }),
        { type: 'FLAG_ANNOTATED', id: 'flag-1', note: 'The same image opened the script' }
      )

      expect(state.flags[0]?.note).toBe('The same image opened the script')
    })

    it('removes a note that has been emptied rather than storing an empty one', () => {
      const annotated = markReducer(
        loaded({ flags: [flag({ note: 'something' })] }),
        { type: 'FLAG_ANNOTATED', id: 'flag-1', note: '   ' }
      )

      expect(annotated.flags[0]).toEqual(flag())
      expect(Object.keys(annotated.flags[0] ?? {})).not.toContain('note')
    })

    it('leaves the state alone when nothing actually changed', () => {
      const state = loaded({ flags: [flag({ label: 'Too abstract' })] })
      const relabelled = markReducer(state, { type: 'FLAG_RELABELLED', id: 'flag-1', label: 'Too abstract' })

      expect(relabelled.flags[0]).toBe(state.flags[0])
    })

    it('ignores a relabelling of a flag that is not there', () => {
      const state = loaded({ flags: [flag()] })

      expect(markReducer(state, { type: 'FLAG_RELABELLED', id: 'gone', label: 'x' }).flags[0])
        .toBe(state.flags[0])
    })

    // M5: the saving effect watches the state object itself, so a no-op that
    // hands back a new one rewrites localStorage for nothing.
    it('hands back the very state it was given when a relabelling changes nothing', () => {
      const state = loaded({ flags: [flag({ label: 'Too abstract' })] })

      expect(markReducer(state, { type: 'FLAG_RELABELLED', id: 'flag-1', label: 'Too abstract' }))
        .toBe(state)
      expect(markReducer(state, { type: 'FLAG_RELABELLED', id: 'gone', label: 'x' })).toBe(state)
    })

    it('hands back the very state it was given when an annotation changes nothing', () => {
      const state = loaded({ flags: [flag({ note: 'the same note' })] })

      expect(markReducer(state, { type: 'FLAG_ANNOTATED', id: 'flag-1', note: 'the same note' }))
        .toBe(state)
      expect(markReducer(state, { type: 'FLAG_ANNOTATED', id: 'gone', note: 'anything' }))
        .toBe(state)
    })

    it('hands back the very state it was given when an empty note is emptied again', () => {
      const state = loaded({ flags: [flag()] })

      expect(markReducer(state, { type: 'FLAG_ANNOTATED', id: 'flag-1', note: '  ' })).toBe(state)
    })
  })

  describe('putting a mark away', () => {
    it('discards a dismissed flag', () => {
      const state = markReducer(loaded({ flags: [flag()] }), { type: 'FLAG_DISMISSED', id: 'flag-1' })

      expect(state.flags).toEqual([])
    })

    // A dismissal changes nothing in the conversation: the model did make the
    // finding, so it is remembered as hidden rather than deleted, and can come
    // back.
    it('remembers a dismissed finding as hidden', () => {
      const state = markReducer(loaded(), { type: 'FINDING_DISMISSED', key: 'style-key' })

      expect(state.dismissed).toEqual(['style-key'])
      expect(markReducer(state, { type: 'FINDING_RESTORED', key: 'style-key' }).dismissed).toEqual([])
    })

    it('does not record the same dismissal twice', () => {
      const first = markReducer(loaded(), { type: 'FINDING_DISMISSED', key: 'style-key' })

      expect(markReducer(first, { type: 'FINDING_DISMISSED', key: 'style-key' })).toBe(first)
    })

    it('ignores restoring a finding that was never dismissed', () => {
      const state = loaded({ dismissed: ['style-key'] })

      expect(markReducer(state, { type: 'FINDING_RESTORED', key: 'other' })).toBe(state)
    })
  })

  describe('spending a mark on a rewrite', () => {
    // The body the mark named is about to be replaced, so the mark goes with
    // it: a mark left hanging over words nobody has written yet is the silent
    // wrongness this feature exists to remove (M4).
    it('discards the flag it was spent from', () => {
      const state = markReducer(loaded({ flags: [flag()] }), { type: 'FLAG_SPENT', id: 'flag-1' })

      expect(state.flags).toEqual([])
    })

    // M4: the reader PAID a rewrite for this finding. Counting it among the
    // dismissed would list it under "Show N dismissed findings" and offer to
    // restore a finding about words that have since been replaced.
    it('remembers the finding it was spent from apart from the dismissed ones', () => {
      const state = markReducer(loaded(), { type: 'FINDING_SPENT', key: 'style-key' })

      expect(state.spent).toEqual(['style-key'])
      expect(state.dismissed).toEqual([])
    })

    it('does not bring a spent finding back when the dismissed ones are restored', () => {
      const state = markReducer(loaded(), { type: 'FINDING_SPENT', key: 'style-key' })

      expect(markReducer(state, { type: 'FINDING_RESTORED', key: 'style-key' })).toBe(state)
    })

    it('does not record the same spend twice', () => {
      const first = markReducer(loaded(), { type: 'FINDING_SPENT', key: 'style-key' })

      expect(markReducer(first, { type: 'FINDING_SPENT', key: 'style-key' })).toBe(first)
    })

    it('leaves every other mark on the section alone', () => {
      const state = markReducer(
        loaded({
          flags: [
            flag(),
            flag({
              id: 'flag-2',
              anchor: { quote: 'without any help from you', before: '', after: '', occurrence: 0 }
            })
          ],
          dismissed: ['other-key']
        }),
        { type: 'FLAG_SPENT', id: 'flag-1' }
      )

      expect(state.flags.map(stored => stored.id)).toEqual(['flag-2'])
      expect(state.dismissed).toEqual(['other-key'])
    })
  })

  // M4: nothing pruned these lists, so every dismissal and spend the reader
  // ever made stayed in storage for the life of the script.
  describe('reading the findings the document still carries', () => {
    it('forgets a dismissal of a finding the document no longer carries', () => {
      const state = loaded({ dismissed: ['gone-key', 'live-key'] })

      expect(markReducer(state, { type: 'FINDINGS_OBSERVED', keys: ['live-key'] }).dismissed)
        .toEqual(['live-key'])
    })

    it('forgets a spend of a finding the document no longer carries', () => {
      const state = loaded({ spent: ['gone-key', 'live-key'] })

      expect(markReducer(state, { type: 'FINDINGS_OBSERVED', keys: ['live-key'] }).spent)
        .toEqual(['live-key'])
    })

    it('leaves the reader\'s own flags alone: they name passages, not findings', () => {
      const state = loaded({ flags: [flag()] })

      expect(markReducer(state, { type: 'FINDINGS_OBSERVED', keys: [] }).flags)
        .toEqual([flag()])
    })

    it('hands back the very state it was given when there is nothing to forget', () => {
      const state = loaded({ dismissed: ['live-key'], spent: ['other-key'] })

      expect(markReducer(state, { type: 'FINDINGS_OBSERVED', keys: ['live-key', 'other-key'] }))
        .toBe(state)
    })
  })

  describe('what gets stored', () => {
    it('is the marks without the script id they are filed under', () => {
      expect(marksToStore(loaded({
        flags: [flag()],
        dismissed: ['style-key'],
        spent: ['spent-key']
      }))).toEqual({ flags: [flag()], dismissed: ['style-key'], spent: ['spent-key'] })
    })
  })
})
