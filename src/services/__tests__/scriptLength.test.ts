import { describe, it, expect } from 'vitest'
import {
  buildLengthPlan,
  clampTargetMinutes,
  formatTargetLength,
  DEFAULT_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
  MAX_TARGET_MINUTES,
  MIN_TOTAL_WORDS,
  MIN_SECTIONS,
  MAX_SECTIONS
} from '../scriptLength'
import { WORDS_PER_MINUTE } from '../../utils/scriptMetrics'

describe('clampTargetMinutes', () => {
  it('keeps a length inside the control range', () => {
    expect(clampTargetMinutes(30)).toBe(30)
  })

  it('holds the floor and the ceiling', () => {
    expect(clampTargetMinutes(1)).toBe(MIN_TARGET_MINUTES)
    expect(clampTargetMinutes(500)).toBe(MAX_TARGET_MINUTES)
  })

  it('falls back to the default for a value that is not a number', () => {
    expect(clampTargetMinutes(Number.NaN)).toBe(DEFAULT_TARGET_MINUTES)
  })
})

describe('buildLengthPlan', () => {
  it('turns minutes into a word count at the assumed spoken pace', () => {
    const plan = buildLengthPlan(30)

    expect(plan.targetMinutes).toBe(30)
    expect(plan.totalWords).toBe(30 * WORDS_PER_MINUTE)
  })

  it('never plans a script below the minimum useful length', () => {
    expect(buildLengthPlan(1).totalWords).toBeGreaterThanOrEqual(MIN_TOTAL_WORDS)
  })

  it('leaves more room above the target than below it, since the brief may need it', () => {
    const plan = buildLengthPlan()

    expect(plan.totalWords - plan.minWords).toBeLessThan(plan.maxWords - plan.totalWords)
  })

  it('spends a longer target on more sections rather than longer ones', () => {
    const short = buildLengthPlan(15)
    const long = buildLengthPlan(50)

    expect(long.sectionCount).toBeGreaterThan(short.sectionCount)
    expect(Math.abs(long.sectionWords - short.sectionWords)).toBeLessThan(150)
  })

  it('keeps the section count within the range one call can write coherently', () => {
    for (let minutes = MIN_TARGET_MINUTES; minutes <= MAX_TARGET_MINUTES; minutes += 5) {
      const plan = buildLengthPlan(minutes)
      expect(plan.sectionCount).toBeGreaterThanOrEqual(MIN_SECTIONS)
      expect(plan.sectionCount).toBeLessThanOrEqual(MAX_SECTIONS)
    }
  })
})

describe('formatTargetLength', () => {
  it('states the target as both minutes and words', () => {
    expect(formatTargetLength(buildLengthPlan(20))).toBe('~20 min · ~2,600 words')
  })
})
