// Pinning a quoted passage to the body it claims to come from.
//
// A span is recorded as the QUOTE, a bounded amount of the body either side of
// it, and WHICH OCCURRENCE of the quote it was. It is never recorded as an
// offset: section_revise replaces a whole body, so an offset pinned when a
// finding was accepted is wrong the instant the model answers, and wrong
// silently — the number still indexes into the new body, it just names
// different words. Quoting the passage instead means the same arithmetic finds
// it again, or honestly reports that it is gone.
//
// Nothing here throws. A quote the model typed wrong is ordinary data, and
// SpanFault is how it is reported; turning it into an error is the caller's
// decision, made where the caller knows what message the model needs to hear.
// That is also what keeps this module free of every import, so it is readable
// and testable in the node environment the tests run in.

// Characters of surrounding body kept on each side of a quoted passage. Wider
// than the source this was ported from, because a section here is written
// against a [400, 750] word window and a short window repeats more often in a
// body that long.
export const SPAN_CONTEXT_CHARS = 48

// Longest passage a span may quote; beyond it the fault is the section, not a
// passage in it, and there is a tool for that.
export const SPAN_QUOTE_MAX = 400

// Shortest passage a span may quote, measured after the inward trim.
//
// Uniqueness is only survivable if a span is longer than an accident: a
// four-character span is unique in today's body and ambiguous after one
// insertion somewhere else entirely. Sixteen is a starting number scaled to
// this project's longer bodies, and it is the number that decides how often a
// model is told to quote a full clause — so every 'short' and 'ambiguous'
// fault is worth logging until it has been retuned against what models
// actually produce.
export const SPAN_MIN_CHARS = 16

// Where a passage sits in a body, in the four fields that survive a whole-body
// rewrite.
export interface SpanAnchor {
  // The passage verbatim, always sliced from the body rather than copied from
  // the claim.
  readonly quote: string
  // Up to SPAN_CONTEXT_CHARS of body immediately before it.
  readonly before: string
  // Up to SPAN_CONTEXT_CHARS immediately after.
  readonly after: string
  // Which occurrence of the quote in that body this was, counting from zero.
  readonly occurrence: number
}

// Why a quoted passage could not be pinned to a body.
export type SpanFault = 'empty' | 'short' | 'long' | 'absent' | 'ambiguous'

// The outcome of pinning one quoted passage to one body. A fault is a value
// rather than an exception because the caller has to tell the model which rule
// it broke, and with what numbers.
export type SpanResolution =
  | {
    readonly ok: true
    // Where the passage sits, measured off the body.
    readonly anchor: SpanAnchor
    // Length of the pinned passage in the body's own characters.
    readonly chars: number
  }
  | {
    readonly ok: false
    // Which rule the quote failed.
    readonly fault: SpanFault
    // What was measured, so the rejection can quote the number back.
    readonly chars: number
    // How many times the quote appears; only meaningful for 'ambiguous'.
    readonly matches: number
  }

// Every offset at which `needle` begins in `haystack`, in ascending order.
//
// Advances by one character rather than by the needle's length, because a
// quote may overlap itself and a miscount here would pin a mark to the wrong
// copy of a repeated phrase. An empty needle finds nothing.
export function spanOffsets(haystack: string, needle: string): readonly number[] {
  if (needle === '') return []
  const found: number[] = []
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + 1)) {
    found.push(from)
  }
  return found
}

// Which occurrence of `quote` begins at `start`, counting from zero, or -1
// when the quote does not begin there at all.
export function occurrenceAt(body: string, start: number, quote: string): number {
  if (quote === '' || body.slice(start, start + quote.length) !== quote) return -1
  return spanOffsets(body, quote).filter(offset => offset < start).length
}

// The four anchoring fields of the half-open range [from, to) of `body`.
//
// The quote is the body's own slice, never a string handed in: an anchor that
// recorded the claim rather than the text would survive validation and then
// fail to re-find itself on the very next render.
export function anchorFields(body: string, from: number, to: number): SpanAnchor {
  const quote = body.slice(from, to)
  return {
    quote,
    before: body.slice(Math.max(0, from - SPAN_CONTEXT_CHARS), from),
    after: body.slice(to, to + SPAN_CONTEXT_CHARS),
    occurrence: occurrenceAt(body, from, quote)
  }
}

// A text with every whitespace run collapsed, and the map back to the original
// offsets. map[i] is the original index of the character folded to i, and
// map[folded.length] is the text's length.
interface FoldedText {
  readonly folded: string
  readonly map: readonly number[]
}

// Collapse whitespace runs, keeping the way back.
//
// Folding is the only tolerance this module extends. A model quoting across a
// line break types a space, and rejecting that teaches it nothing about the
// fault it found; anything looser — case, punctuation, elided words — would
// pin a mark to a passage the reader cannot find by reading.
const foldSpaces = (text: string): FoldedText => {
  let folded = ''
  const map: number[] = []
  let index = 0
  while (index < text.length) {
    if (/\s/u.test(text.charAt(index))) {
      folded += ' '
      map.push(index)
      while (index < text.length && /\s/u.test(text.charAt(index))) index += 1
    } else {
      folded += text.charAt(index)
      map.push(index)
      index += 1
    }
  }
  map.push(text.length)
  return { folded, map }
}

// Pin a quoted passage to the body it claims to come from.
//
// Uniqueness is required rather than resolved by position: a quote appearing
// twice names two passages, and choosing the first would silently mark the one
// the finding did not mean. The cost is that a repetition finding — where the
// fault IS that a phrase recurs — cannot be one span; it is several, each
// extended into its own surrounding words, which is what wants underlining
// anyway.
export function resolveSpan(body: string, quote: string): SpanResolution {
  const claim = foldSpaces(quote).folded.replace(/^ /u, '').replace(/ $/u, '')
  if (claim.length === 0) return { ok: false, fault: 'empty', chars: 0, matches: 0 }
  if (claim.length < SPAN_MIN_CHARS) return { ok: false, fault: 'short', chars: claim.length, matches: 0 }
  if (claim.length > SPAN_QUOTE_MAX) return { ok: false, fault: 'long', chars: claim.length, matches: 0 }
  const { folded, map } = foldSpaces(body)
  const hits = spanOffsets(folded, claim)
  if (hits.length === 0) return { ok: false, fault: 'absent', chars: claim.length, matches: 0 }
  if (hits.length > 1) return { ok: false, fault: 'ambiguous', chars: claim.length, matches: hits.length }
  // Both ends are exact because `claim` neither begins nor ends with a space,
  // so neither maps into the middle of a collapsed run.
  const first = hits[0] ?? 0
  const start = map[first] ?? 0
  const end = (map[first + claim.length - 1] ?? 0) + 1
  // The cap is re-checked in the body's own characters, because that is what
  // gets recorded: one folded space may stand for a paragraph break or a run
  // of indentation, so a claim inside the cap can pin a materially longer
  // quote, and it is the recorded quote the cap is a rule about.
  if (end - start > SPAN_QUOTE_MAX) {
    return { ok: false, fault: 'long', chars: end - start, matches: 1 }
  }
  return { ok: true, anchor: anchorFields(body, start, end), chars: end - start }
}

// How confidently a recorded span was re-found in the body as it now reads.
export type SpanAnchorState = 'anchored' | 'shifted' | 'stale'

// A recorded span paired with where it landed in the body as it now reads.
export interface SpanPlacement {
  readonly anchor: SpanAnchor
  // Character offset of the quote's first character in the current body, or -1
  // when the passage is gone. Valid only for the body it was computed against:
  // it is a render-time answer, never something to write back.
  readonly start: number
  // Character offset one past its last character, or -1 when it is gone.
  readonly end: number
  readonly state: SpanAnchorState
}

// Re-find one recorded span in a body that may have been rewritten, trying
// four descending degrees of confidence.
//
// The search runs over FOLDED text, on exactly the rule resolveSpan pins by.
// The two sides have to agree about what "the same passage" is: a body whose
// whitespace was reflowed — a paragraph rewrapped, a line break where a space
// used to be — holds the passage verbatim as far as any reader can tell, and
// an exact indexOf here would report it gone and offer to repair words that
// are still on the screen. That false report is the failure the occurrence
// index exists to avoid, so nothing is gained by being stricter here than the
// rule the quote was admitted under.
//
// The context window is tried BEFORE the occurrence index because a sentence
// inserted above the quote shifts every index below it while leaving the words
// on either side of the passage exactly as they were. Falling back to the sole
// surviving occurrence is a guess, and it says so: 'shifted' is a signal to
// show the reader, never a safety mechanism to gate on.
export function reanchorSpan(body: string, anchor: SpanAnchor): SpanPlacement {
  const gone: SpanPlacement = { anchor, start: -1, end: -1, state: 'stale' }
  const quote = foldSpaces(anchor.quote).folded
  if (quote === '') return gone

  const { folded, map } = foldSpaces(body)
  // Placement in the body's OWN characters: the offsets are what a renderer
  // slices with, so they can never be folded ones. The quote neither begins
  // nor ends inside a whitespace run — anchorFields cut it out of a body at
  // both ends of a passage — so both edges map back exactly.
  const at = (foldedStart: number, state: SpanAnchorState): SpanPlacement => ({
    anchor,
    start: map[foldedStart] ?? 0,
    end: (map[foldedStart + quote.length - 1] ?? 0) + 1,
    state
  })

  // Folding the three parts separately is the same string as folding the
  // window whole, because no whitespace run spans either seam.
  const before = foldSpaces(anchor.before).folded
  const window = `${before}${quote}${foldSpaces(anchor.after).folded}`
  const windows = spanOffsets(folded, window)
  if (windows.length === 1) {
    return at((windows[0] ?? 0) + before.length, 'anchored')
  }

  const quotes = spanOffsets(folded, quote)
  const nth = quotes[anchor.occurrence]
  if (nth !== undefined) return at(nth, 'anchored')
  if (quotes.length === 1) return at(quotes[0] ?? 0, 'shifted')
  return gone
}
