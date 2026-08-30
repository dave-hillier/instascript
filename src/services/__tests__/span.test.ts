import { describe, it, expect } from 'vitest'
import {
  anchorFields,
  occurrenceAt,
  reanchorSpan,
  resolveSpan,
  spanOffsets,
  SPAN_CONTEXT_CHARS,
  SPAN_MIN_CHARS,
  SPAN_QUOTE_MAX
} from '../span'

// What may be pinned to a body, and what the pin records. These are the
// measurements a critique's quote and a reader's own flag are both judged by,
// so they are tested once, here — the whole reason the module exists is that
// there must not be a second copy of the arithmetic to test.

const BODY = 'The gentle rhythm of your breathing carries you deeper,\nand deeper still, '
  + 'until the room itself softens around you.'

describe('finding a passage in a body', () => {
  it('finds every start of a needle that overlaps itself', () => {
    // Advancing by the needle's length would report one match where there are
    // two, and pin a mark to the wrong copy of a repeated phrase.
    expect(spanOffsets('aaaa', 'aa')).toEqual([0, 1, 2])
    expect(spanOffsets('aaaa', '')).toEqual([])
  })

  it('counts which occurrence begins at an offset, and refuses one that does not', () => {
    expect(occurrenceAt('one two one two', 0, 'one')).toBe(0)
    expect(occurrenceAt('one two one two', 8, 'one')).toBe(1)
    expect(occurrenceAt('one two one two', 1, 'one')).toBe(-1)
  })
})

describe('the four fields that survive a whole-body rewrite', () => {
  it('keeps a bounded window either side, and stops at the body edges', () => {
    const padded = `Let the chair take your weight, all of it.\n\n${BODY}`
    const middle = anchorFields(padded, padded.indexOf('carries'), padded.indexOf('carries') + 7)
    expect(middle.quote).toBe('carries')
    expect(middle.before).toHaveLength(SPAN_CONTEXT_CHARS)
    expect(middle.before.endsWith('your breathing ')).toBe(true)
    expect(middle.after).toHaveLength(SPAN_CONTEXT_CHARS)
    expect(middle.after.startsWith(' you deeper,\nand deeper still,')).toBe(true)

    // The window is clipped by the body's own ends rather than padded.
    const nearStart = anchorFields(BODY, 36, 43)
    expect(nearStart.before).toBe(BODY.slice(0, 36))

    const edge = anchorFields(BODY, 0, 3)
    expect(edge.before).toBe('')
    expect(anchorFields(BODY, BODY.length - 3, BODY.length).after).toBe('')
  })

  it('records which occurrence of a repeated phrase was named', () => {
    const twice = 'sink down and rest. sink down and rest.'
    expect(anchorFields(twice, 20, 38).occurrence).toBe(1)
  })
})

describe('pinning a quoted passage', () => {
  it('pins a unique quote and measures its occurrence', () => {
    const pinned = resolveSpan(BODY, 'carries you deeper')
    expect(pinned).toMatchObject({ ok: true, chars: 18 })
    expect(pinned.ok && pinned.anchor).toMatchObject({
      quote: 'carries you deeper',
      occurrence: 0
    })
    expect(pinned.ok && pinned.anchor.after.startsWith(',\nand deeper still,')).toBe(true)
  })

  it("tolerates a whitespace run the model typed differently, and records the body's own slice", () => {
    // A model quoting across a line break types a space. Rejecting that
    // teaches it nothing about the fault, and recording its string rather than
    // the body's would leave a mark that cannot re-find itself.
    const pinned = resolveSpan(BODY, 'deeper, and deeper still')
    expect(pinned.ok && pinned.anchor.quote).toBe('deeper,\nand deeper still')
    expect(resolveSpan('one\n\ntwo three four', 'one two three four').ok).toBe(true)
  })

  it('refuses a quote that names two passages, and says how many', () => {
    expect(resolveSpan('sink down and rest. sink down and rest.', 'sink down and rest'))
      .toEqual({ ok: false, fault: 'ambiguous', chars: 18, matches: 2 })
  })

  it('refuses a paraphrase', () => {
    expect(resolveSpan(BODY, 'the soft rhythm of your breath'))
      .toMatchObject({ ok: false, fault: 'absent' })
  })

  it('refuses an empty quote', () => {
    expect(resolveSpan(BODY, '  \n ')).toEqual({ ok: false, fault: 'empty', chars: 0, matches: 0 })
  })

  it('holds the length bounds at their own boundaries', () => {
    const short = 'x'.repeat(SPAN_MIN_CHARS - 1)
    expect(resolveSpan(short, short)).toMatchObject({ ok: false, fault: 'short', chars: SPAN_MIN_CHARS - 1 })
    const least = 'y'.repeat(SPAN_MIN_CHARS)
    expect(resolveSpan(least, least).ok).toBe(true)
    const most = 'z'.repeat(SPAN_QUOTE_MAX)
    expect(resolveSpan(most, most).ok).toBe(true)
    const over = 'w'.repeat(SPAN_QUOTE_MAX + 1)
    expect(resolveSpan(over, over)).toMatchObject({ ok: false, fault: 'long', chars: SPAN_QUOTE_MAX + 1 })
  })

  it("holds the cap in the body's own characters, not the folded claim's", () => {
    // One folded space may stand for a paragraph break or a run of
    // indentation, so a claim inside the cap can pin a materially longer
    // quote — and the reader's own span is measured unfolded. The two sides of
    // the shared measurement have to agree about the same rule.
    const half = 'y'.repeat(SPAN_QUOTE_MAX / 2 - 1)
    const body = `${half}\n\n          ${half}`
    expect(body.length).toBeGreaterThan(SPAN_QUOTE_MAX)
    expect(resolveSpan(body, `${half} ${half}`))
      .toEqual({ ok: false, fault: 'long', chars: body.length, matches: 1 })
  })

  it('is short of sixteen characters that a fragment fails on', () => {
    // The number that decides how often a model is told to quote a full
    // clause; it is written down here so retuning it is a deliberate change.
    expect(SPAN_MIN_CHARS).toBe(16)
    expect(resolveSpan(BODY, 'you deeper')).toMatchObject({ ok: false, fault: 'short', chars: 10 })
  })
})

describe('re-finding a span in a body that has moved on', () => {
  const pin = (body: string, quote: string) => {
    const resolved = resolveSpan(body, quote)
    if (!resolved.ok) throw new Error(`fixture quote did not pin: ${resolved.fault}`)
    return resolved.anchor
  }

  it('finds a passage that has not moved', () => {
    const anchor = pin(BODY, 'carries you deeper')
    const placed = reanchorSpan(BODY, anchor)
    expect(placed.state).toBe('anchored')
    expect(BODY.slice(placed.start, placed.end)).toBe('carries you deeper')
  })

  it('follows a passage pushed down the body by a sentence inserted above it', () => {
    // The context window is tried first for exactly this: an insertion above
    // shifts every offset below it while leaving the words on either side of
    // the passage untouched.
    const anchor = pin(BODY, 'carries you deeper')
    const rewritten = `Settle back into the chair.\n\n${BODY}`
    const placed = reanchorSpan(rewritten, anchor)
    expect(placed.state).toBe('anchored')
    expect(placed.start).toBe(BODY.indexOf('carries you deeper') + 29)
    expect(rewritten.slice(placed.start, placed.end)).toBe('carries you deeper')
  })

  it('finds a passage whose surroundings were rewritten but whose words were not', () => {
    // The context window is gone, so the occurrence index carries it: this is
    // still the first occurrence of the quote, and still the passage meant.
    const anchor = pin(BODY, 'carries you deeper')
    const rewritten = 'Each slow breath carries you deeper into the quiet.'
    const placed = reanchorSpan(rewritten, anchor)
    expect(placed.state).toBe('anchored')
    expect(rewritten.slice(placed.start, placed.end)).toBe('carries you deeper')
  })

  it('finds a passage the rewrite only reflowed, on the rule it was pinned by', () => {
    // resolveSpan folds whitespace, so a body that has merely been rewrapped
    // still contains the passage by the rule the quote was admitted under. An
    // exact search here would answer "the passage is no longer in this
    // section" about words the reader can see, and offer to repair them.
    const anchor = pin(BODY, 'carries you deeper')
    const reflowed = BODY.replace(/\s+/gu, match => (match.includes('\n') ? ' ' : '\n    '))
    expect(reflowed).not.toContain('carries you deeper')
    const placed = reanchorSpan(reflowed, anchor)
    expect(placed.state).toBe('anchored')
    expect(reflowed.slice(placed.start, placed.end)).toBe('carries\n    you\n    deeper')
  })

  it('reports a passage the rewrite removed as stale rather than guessing', () => {
    const anchor = pin(BODY, 'carries you deeper')
    const placed = reanchorSpan('The room is bright and you are wide awake.', anchor)
    expect(placed).toMatchObject({ state: 'stale', start: -1, end: -1 })
  })

  it('holds the marked occurrence when the phrase now appears more often', () => {
    const body = 'sink down and rest. Then wake.'
    const anchor = anchorFields(body, 0, 18)
    expect(anchor).toMatchObject({ quote: 'sink down and rest', occurrence: 0 })
    // The same phrase added below: the context window still names the first.
    const grown = 'sink down and rest. Then wake. sink down and rest.'
    expect(reanchorSpan(grown, anchor)).toMatchObject({ state: 'anchored', start: 0, end: 18 })
  })

  const TWICE = 'sink down and rest. Then wake. sink down and rest. Then rise.'

  it('keeps the second copy of a phrase anchored when the context around it survives', () => {
    const anchor = anchorFields(TWICE, 31, 49)
    expect(anchor).toMatchObject({ quote: 'sink down and rest', occurrence: 1 })
    const rewritten = 'Settle first.\n\n' + TWICE
    const placed = reanchorSpan(rewritten, anchor)
    expect(placed.state).toBe('anchored')
    expect(placed.start).toBe(31 + 15)
  })

  it('prefers the surrounding words to the index when a copy is inserted above', () => {
    // The discriminating case for the order of the two degrees: an insertion
    // that itself repeats the quote renumbers every occurrence below it, so
    // the index now names the copy the mark did not mean, while the words on
    // either side still name the copy it did.
    const anchor = anchorFields(TWICE, 31, 49)
    const rewritten = `sink down and rest. First though:\n\n${TWICE}`
    const placed = reanchorSpan(rewritten, anchor)
    expect(placed.state).toBe('anchored')
    expect(placed.start).toBe(rewritten.length - TWICE.length + 31)
  })

  it('falls back to the occurrence index when the context around it changed', () => {
    const anchor = anchorFields(TWICE, 31, 49)
    const rewritten = 'sink down and rest. Then stir. sink down and rest. Then stand.'
    expect(reanchorSpan(rewritten, anchor)).toMatchObject({ state: 'anchored', start: 31 })
  })

  it('marks the sole survivor as shifted once the first copy is deleted', () => {
    // Neither the context nor a second occurrence remains, so placing the mark
    // on the one copy left is a guess. It is reported as a guess and nothing
    // gates on it — but the mark stays on the words, which is the point.
    const anchor = anchorFields(TWICE, 31, 49)
    const trimmedBody = 'Then wake. sink down and rest. Then rise.'
    const placed = reanchorSpan(trimmedBody, anchor)
    expect(placed.state).toBe('shifted')
    expect(placed.start).toBe(11)
    expect(trimmedBody.slice(placed.start, placed.end)).toBe('sink down and rest')
  })
})

// The window is only evidence while it is UNIQUE. Once the same quote with the
// same words either side appears more than once, the window has stopped
// identifying anything and the occurrence index is the only thing that still
// knows which copy was marked. Taking the first match instead would draw the
// mark on the wrong words — the exact failure the uniqueness rule exists for.
describe('a context window that stopped being unique', () => {
  const passage = 'sink a little further into the quiet'
  // One unit, repeated verbatim, so the quote AND both margins recur together
  // and the window stops telling the copies apart
  const unit = `Settle now. ${passage} and rest there. `

  it('falls back to the occurrence index rather than taking the first match', () => {
    const original = unit
    const from = original.indexOf(passage)
    const anchor = anchorFields(original, from, from + passage.length)

    const rewritten = `${unit}${unit}${unit}`
    const occurrence = 2
    const placement = reanchorSpan(rewritten, { ...anchor, occurrence })
    const offsets = spanOffsets(rewritten, passage)

    // The window now matches every copy, so it identifies nothing and the
    // occurrence index is the only thing left that knows which was marked
    expect(offsets).toHaveLength(3)
    expect(placement.state).toBe('anchored')
    expect(rewritten.slice(placement.start, placement.end)).toBe(passage)
    expect(placement.start).toBe(offsets[occurrence])
    expect(placement.start).not.toBe(offsets[0])
  })
})

// Written against the literal values rather than as `MAX + 1`, so the tests
// cannot move with the constant they are meant to pin. The cap is the rule that
// keeps a span pointing at the phrase at fault instead of the paragraph around
// it, and a bound nothing holds is not a bound.
describe('the recorded bounds', () => {
  it('pins the values the acceptance rules are written against', () => {
    expect(SPAN_MIN_CHARS).toBe(16)
    expect(SPAN_QUOTE_MAX).toBe(400)
    expect(SPAN_CONTEXT_CHARS).toBe(48)
  })

  it('refuses a quote longer than the cap and accepts one at it', () => {
    // Distinct words, so a slice of it is unique and the length rule is the
    // only thing the resolution can be deciding on
    const middle = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
    const body = `Settle now. ${middle} Rest there.`
    const atCap = body.slice(12, 12 + SPAN_QUOTE_MAX)
    const overCap = body.slice(12, 12 + SPAN_QUOTE_MAX + 1)

    expect(resolveSpan(body, atCap).ok).toBe(true)
    const refused = resolveSpan(body, overCap)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.fault).toBe('long')
  })
})
