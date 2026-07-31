import { WORDS_PER_MINUTE } from '../utils/scriptMetrics'
import { SECTION_TARGET_WORDS } from './sectionQuality'

// The user picks how long the finished script should run when spoken aloud,
// and everything downstream is derived from that one number: the word count
// the script aims at, how many sections the outline plans, and the window the
// whole-script review judges the finished length against.
//
// The target is advisory throughout. A brief can plainly need more material
// than the requested length allows, so the prompts ask for the target as an
// aim rather than a limit, and the review only corrects a script that has
// drifted well clear of it.

export const DEFAULT_TARGET_MINUTES = 25
export const MAX_TARGET_MINUTES = 60
export const TARGET_MINUTES_STEP = 5

// Below this a script has no room for an induction, an arc and a return, so
// it is the floor of the control rather than a value the user can pick
export const MIN_TOTAL_WORDS = 1200
export const MIN_TARGET_MINUTES = Math.ceil(MIN_TOTAL_WORDS / WORDS_PER_MINUTE)

// How far the finished script may sit from its target and still count as the
// length that was asked for. The window is deliberately lopsided: a script
// that ran long usually did so because the brief needed the material, while
// one that came up short is more often thin.
export const UNDER_TOLERANCE = 0.15
export const OVER_TOLERANCE = 0.25

// Sections stay at roughly the nominal per-section length whatever the total,
// so a longer script means more sections rather than longer ones
export const MIN_SECTIONS = 3
export const MAX_SECTIONS = 12

export interface LengthPlan {
  targetMinutes: number
  totalWords: number
  // The window the finished script counts as on target within
  minWords: number
  maxWords: number
  sectionCount: number
  sectionWords: number
}

export function clampTargetMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_TARGET_MINUTES
  return Math.min(MAX_TARGET_MINUTES, Math.max(MIN_TARGET_MINUTES, Math.round(minutes)))
}

export function buildLengthPlan(targetMinutes: number = DEFAULT_TARGET_MINUTES): LengthPlan {
  const minutes = clampTargetMinutes(targetMinutes)
  const totalWords = Math.max(MIN_TOTAL_WORDS, minutes * WORDS_PER_MINUTE)
  const sectionCount = Math.min(
    MAX_SECTIONS,
    Math.max(MIN_SECTIONS, Math.round(totalWords / SECTION_TARGET_WORDS))
  )

  return {
    targetMinutes: minutes,
    totalWords,
    minWords: Math.round(totalWords * (1 - UNDER_TOLERANCE)),
    maxWords: Math.round(totalWords * (1 + OVER_TOLERANCE)),
    sectionCount,
    sectionWords: Math.round(totalWords / sectionCount)
  }
}

// The control's own indicator: the length being asked for, in both the unit
// the user picked and the unit the script is measured in
export function formatTargetLength(plan: LengthPlan): string {
  return `~${plan.targetMinutes} min · ~${plan.totalWords.toLocaleString('en-US')} words`
}
