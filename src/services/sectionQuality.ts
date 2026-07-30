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
