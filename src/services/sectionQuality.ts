import { countWords } from '../utils/scriptMetrics'

// A generated section targets ~400 words; anything roughly outside 250-600
// is retried once, and the attempt closer to the target is kept.

export const SECTION_TARGET_WORDS = 400
export const SECTION_MIN_WORDS = 250
export const SECTION_MAX_WORDS = 600

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
