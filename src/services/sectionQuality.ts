import { countWords } from '../utils/scriptMetrics'

// A generated section targets ~550 words; anything roughly outside 400-750
// is retried once, and the attempt closer to the target is kept.
//
// The targets are set so the script as a whole lands in its 20-30 minute
// spoken window (see scriptReview): six sections at ~550 words is ~3,300
// words, about 25 minutes at 130 wpm. Six moderate sections beat five long
// ones — the outline gets finer-grained control of the arc, and each section
// is still written in one call short enough to stay internally coherent.

export const SECTION_TARGET_WORDS = 550
export const SECTION_MIN_WORDS = 400
export const SECTION_MAX_WORDS = 750

export function shouldRetrySection(wordCount: number): boolean {
  return wordCount < SECTION_MIN_WORDS || wordCount > SECTION_MAX_WORDS
}

// Keeps the attempt whose word count is closer to the target; on a tie the
// first attempt wins, since it was written without the corrective note.
export function pickBetterSectionText(firstAttempt: string, retryAttempt: string): string {
  const firstDistance = Math.abs(countWords(firstAttempt) - SECTION_TARGET_WORDS)
  const retryDistance = Math.abs(countWords(retryAttempt) - SECTION_TARGET_WORDS)
  return retryDistance < firstDistance ? retryAttempt : firstAttempt
}

export function buildRetryNote(wordCount: number): string {
  const problem = wordCount < SECTION_MIN_WORDS ? 'too short' : 'too long'
  return `Note: the previous attempt at this section was ${wordCount} words, which is ${problem}. ` +
    `Rewrite it aiming for approximately ${SECTION_TARGET_WORDS} words ` +
    `(it must be between ${SECTION_MIN_WORDS} and ${SECTION_MAX_WORDS} words).`
}

// --- the rejection loop (tool-call authoring) ----------------------------
//
// On the tool path a section outside the window is not "kept if it happens to
// be the closer of two attempts": the call is REJECTED and the model is told
// so, then asked again. That turns a bounded pick-the-better into an
// iteration, so it needs its own ceiling. pickBetterSectionText was the only
// thing bounding section iteration before; without a replacement a stubborn
// model would loop against a paid API inside a browser tab.
//
// Two ceilings, because one is not enough. The per-section cap stops a single
// impossible section from consuming the run, and the per-run budget stops a
// model that is systematically writing long from paying the per-section cap
// over and over for every section of the script.
export const MAX_SECTION_ATTEMPTS = 4
export const SECTION_REJECTION_BUDGET = 12

// A turn that made no writing call is not a writing attempt: a compliant model
// opens by calling grounding_select, and a confused one calls a tool this step
// does not need. Both are answered with a tool result and asked again with the
// tools still attached, so neither should spend a section's writing attempts.
// They still cost a request each, so they get a ceiling of their own.
export const MAX_TOOL_HANDSHAKES = 3

// The rejection handed back as the tool result for a call that missed the
// window. It is deliberately framed as the CALL having failed rather than as a
// fresh request: the model is reading a tool result, and a tool result that
// reads like a prompt invites it to argue with the number instead of writing
// to it. The measured count, the direction and the range are all stated, so
// the rewrite has everything it needs without re-reading the section.
export function buildSectionRejection(wordCount: number): string {
  const problem = wordCount < SECTION_MIN_WORDS ? 'short' : 'long'
  const direction = wordCount < SECTION_MIN_WORDS ? 'longer' : 'shorter'
  return `REJECTED: that body measured ${wordCount} words, which is too ${problem}. ` +
    `The section was not written. Call the tool again with the whole section rewritten ` +
    `${direction}, aiming for approximately ${SECTION_TARGET_WORDS} words ` +
    `(it must be between ${SECTION_MIN_WORDS} and ${SECTION_MAX_WORDS} words).`
}

// Why a body was kept anyway once the attempts ran out (D5). Recorded on the
// call so the waiver stays visible instead of reading as a clean acceptance.
//
// There is one wording because there is one waiver: only an attempt that
// finished cleanly with a body is ever a waiver candidate (D6), so every
// waived section is one that finished and missed the word window. A run whose
// attempts were a mix — some truncated, some the wrong length — is waived on
// one of the finished ones, and this wording is true of that run too: it says
// none of the attempts both finished and landed in the window, which is why
// this one was kept.
export function buildSectionWaiver(wordCount: number, attempts: number): string {
  return `Kept at ${wordCount} words after ${attempts} attempts; none of them both finished ` +
    `and landed between ${SECTION_MIN_WORDS} and ${SECTION_MAX_WORDS} words.`
}

// How far an attempt sits from the target, so the closest of several attempts
// can be picked when the budget runs out. pickBetterSectionText answers the
// same question for exactly two attempts and is kept for the prose path.
export function sectionDistanceFromTarget(wordCount: number): number {
  return Math.abs(wordCount - SECTION_TARGET_WORDS)
}
