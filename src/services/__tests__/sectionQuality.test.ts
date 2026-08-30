import { describe, it, expect } from 'vitest'
import {
  shouldRetrySection,
  pickBetterSectionText,
  buildRetryNote,
  buildSectionRejection,
  buildSectionWaiver,
  sectionDistanceFromTarget,
  MAX_SECTION_ATTEMPTS,
  SECTION_REJECTION_BUDGET,
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

describe('buildSectionRejection', () => {
  it('tells the model the call failed rather than re-prompting it', () => {
    const rejection = buildSectionRejection(120)

    expect(rejection.startsWith('REJECTED')).toBe(true)
    expect(rejection).toContain('The section was not written')
    expect(rejection).toContain('120 words')
    expect(rejection).toContain('too short')
    expect(rejection).toContain('longer')
    expect(rejection).toContain(`between ${SECTION_MIN_WORDS} and ${SECTION_MAX_WORDS}`)
  })

  it('names the other direction for an over-length body', () => {
    const rejection = buildSectionRejection(SECTION_MAX_WORDS + 50)

    expect(rejection).toContain('too long')
    expect(rejection).toContain('shorter')
  })
})

describe('buildSectionWaiver', () => {
  it('states the count it was kept at and how many attempts were spent', () => {
    const waiver = buildSectionWaiver(900, MAX_SECTION_ATTEMPTS)

    expect(waiver).toContain('900 words')
    expect(waiver).toContain(`${MAX_SECTION_ATTEMPTS} attempts`)
    expect(waiver).toContain(`between ${SECTION_MIN_WORDS} and ${SECTION_MAX_WORDS}`)
  })

  // The waiver is the artefact that has to stay honest. A run can mix the two
  // failures — some attempts truncated, some the wrong length — and it is
  // always waived on one that finished, so the wording may not claim that
  // EVERY attempt missed the window, only that none both finished and landed
  it('does not claim every attempt missed the window', () => {
    expect(buildSectionWaiver(900, 4)).not.toMatch(/attempts failed to land/)
    expect(buildSectionWaiver(900, 4)).toContain('none of them both finished')
  })
})

describe('the ceilings on the rejection loop', () => {
  // Without both of these a rejection loop is unbounded against a paid API in
  // a browser tab, so they are asserted to exist rather than left implicit
  it('bounds a single section and the run as a whole', () => {
    expect(MAX_SECTION_ATTEMPTS).toBeGreaterThan(1)
    expect(SECTION_REJECTION_BUDGET).toBeGreaterThan(MAX_SECTION_ATTEMPTS)
  })
})

describe('sectionDistanceFromTarget', () => {
  it('measures how far an attempt sits from the target in either direction', () => {
    expect(sectionDistanceFromTarget(SECTION_TARGET_WORDS)).toBe(0)
    expect(sectionDistanceFromTarget(SECTION_TARGET_WORDS + 40)).toBe(40)
    expect(sectionDistanceFromTarget(SECTION_TARGET_WORDS - 40)).toBe(40)
  })
})
