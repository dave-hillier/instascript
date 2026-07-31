import { describe, it, expect } from 'vitest'
import {
  shouldRetrySection,
  pickBetterSectionText,
  buildRetryNote,
  SECTION_TARGET_WORDS,
  SECTION_MIN_WORDS,
  SECTION_MAX_WORDS
} from '../sectionQuality'

const words = (count: number): string =>
  Array.from({ length: count }, (_, i) => `w${i}`).join(' ')

describe('shouldRetrySection', () => {
  it('retries a section below the minimum', () => {
    expect(shouldRetrySection(SECTION_MIN_WORDS - 1)).toBe(true)
    expect(shouldRetrySection(0)).toBe(true)
  })

  it('retries a section above the maximum', () => {
    expect(shouldRetrySection(SECTION_MAX_WORDS + 1)).toBe(true)
  })

  it('accepts sections at and within the boundaries', () => {
    expect(shouldRetrySection(SECTION_MIN_WORDS)).toBe(false)
    expect(shouldRetrySection(SECTION_TARGET_WORDS)).toBe(false)
    expect(shouldRetrySection(SECTION_MAX_WORDS)).toBe(false)
  })
})

describe('pickBetterSectionText', () => {
  it('keeps the retry when it is closer to the target', () => {
    const firstAttempt = words(100)
    const retryAttempt = words(SECTION_TARGET_WORDS - 20)

    expect(pickBetterSectionText(firstAttempt, retryAttempt)).toBe(retryAttempt)
  })

  it('keeps the first attempt when the retry lands further from the target', () => {
    const firstAttempt = words(SECTION_TARGET_WORDS - 10)
    const retryAttempt = words(SECTION_TARGET_WORDS + 200)

    expect(pickBetterSectionText(firstAttempt, retryAttempt)).toBe(firstAttempt)
  })

  it('keeps the first attempt on an exact tie', () => {
    const firstAttempt = words(SECTION_TARGET_WORDS - 20)
    const retryAttempt = words(SECTION_TARGET_WORDS + 20)

    expect(pickBetterSectionText(firstAttempt, retryAttempt)).toBe(firstAttempt)
  })
})

describe('buildRetryNote', () => {
  it('describes a short attempt and states the target range', () => {
    const note = buildRetryNote(120)

    expect(note).toContain('120 words')
    expect(note).toContain('too short')
    expect(note).toContain(`approximately ${SECTION_TARGET_WORDS} words`)
    expect(note).toContain(`between ${SECTION_MIN_WORDS} and ${SECTION_MAX_WORDS}`)
  })

  it('describes a long attempt', () => {
    expect(buildRetryNote(SECTION_MAX_WORDS + 50)).toContain('too long')
  })
})
