import type { ReviewRevision } from '../types/conversation'
import type { DocumentSection } from './conversationDocument'
import { countWords, estimateSpokenMinutes } from '../utils/scriptMetrics'
import { buildLengthPlan } from './scriptLength'
import type { LengthPlan } from './scriptLength'

// Story 8.14: the on-demand whole-script review. Where the style pass (8.5)
// judges each section against the numbered style rules in isolation, this pass
// judges the script as one artifact: does it read as a single narrative arc,
// and is it the length it is supposed to be? Pure logic lives here; the
// request itself is buildScriptReviewPrompt in prompts.ts.

// Marker used as the RegenerationRequest section title for the review request
// itself; real providers ignore it, and the mock uses it to return a
// review-shaped response.
export const SCRIPT_REVIEW_SECTION_TITLE = '__script_review__'

// Rewrites per review are capped to bound the cost of the pass
export const MAX_SCRIPT_REVIEW_REVISIONS = 3

// A rewritten section is never asked for an implausible length, however far
// off target the script as a whole is
const REVISION_MIN_WORDS = 300
const REVISION_MAX_WORDS = 900

export type LengthStatus = 'short' | 'on-target' | 'long'

export interface LengthAssessment {
  // The length this script was asked for, so every judgement and every line of
  // reporting is against the target the user picked rather than a fixed one
  plan: LengthPlan
  totalWords: number
  minutes: number
  status: LengthStatus
  // Words to add (positive) or cut (negative) to reach the target itself.
  // Aiming at the target rather than the nearest edge of its window means a
  // rewrite that undershoots its instruction still lands inside the window.
  wordsToTarget: number
  sections: { title: string; wordCount: number }[]
}

export interface ScriptReviewVerdict {
  sectionTitle: string
  cohesive: boolean
  // What the review says is wrong and what the rewrite must do
  issue: string
}

export interface ScriptRevision {
  sectionTitle: string
  currentWords: number
  // Present when the review flagged a cohesion problem
  issue?: string
  // Present when this section is carrying part of a length correction
  wordTarget?: number
}

export function assessScriptLength(
  sections: DocumentSection[],
  plan: LengthPlan = buildLengthPlan()
): LengthAssessment {
  const measured = sections.map(section => ({
    title: section.title,
    wordCount: countWords(section.content)
  }))
  const totalWords = measured.reduce((sum, section) => sum + section.wordCount, 0)

  const status: LengthStatus = totalWords < plan.minWords
    ? 'short'
    : totalWords > plan.maxWords
      ? 'long'
      : 'on-target'

  return {
    plan,
    totalWords,
    minutes: estimateSpokenMinutes(totalWords),
    status,
    wordsToTarget: status === 'on-target' ? 0 : plan.totalWords - totalWords,
    sections: measured
  }
}

// The measured length, stated as fact for the review prompt so the model
// judges pacing against the real number instead of guessing at it
export function formatLengthBrief(assessment: LengthAssessment): string {
  const words = assessment.totalWords.toLocaleString('en-US')
  const target = `The requested length is about ${assessment.plan.targetMinutes} minutes spoken ` +
    `(${assessment.plan.totalWords.toLocaleString('en-US')} words), which is a target rather than a limit.`
  const perSection = assessment.sections
    .map(section => `- "${section.title}": ${section.wordCount} words`)
    .join('\n')

  const headline = assessment.status === 'on-target'
    ? `The script is ${words} words, about ${assessment.minutes} minutes spoken. ${target} The length is on target.`
    : assessment.status === 'short'
      ? `The script is ${words} words, about ${assessment.minutes} minutes spoken. ${target} ` +
        `It is roughly ${Math.abs(assessment.wordsToTarget)} words short, so say which sections have ` +
        'material that deserves more development rather than which could simply be padded.'
      : `The script is ${words} words, about ${assessment.minutes} minutes spoken. ${target} ` +
        `It runs roughly ${Math.abs(assessment.wordsToTarget)} words long, so say which sections repeat ` +
        'or dwell on ground already covered. Leave the length alone where the brief needs the material.'

  return `${headline}\n\nWord count per section:\n${perSection}`
}

// Parses the line-oriented review format:
//   VERDICT: <title> | cohesive
//   VERDICT: <title> | revise | <what is wrong and what the rewrite must do>
// Anything that does not fit the format is skipped, and the first verdict per
// section wins, so preamble or repeated lines from a less obedient model are
// tolerated.
export function parseScriptReviewResponse(text: string): ScriptReviewVerdict[] {
  const verdicts: ScriptReviewVerdict[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split('\n')) {
    const match = rawLine.match(/^\s*(?:[-*]\s*)?VERDICT:\s*(.+)$/i)
    if (!match) continue

    const parts = match[1].split('|').map(part => part.trim())
    if (parts.length < 2) continue

    const sectionTitle = parts[0].replace(/^["']+|["']+$/g, '').trim()
    if (!sectionTitle || seen.has(sectionTitle)) continue

    const status = parts[1]
    if (/^cohesive$/i.test(status)) {
      seen.add(sectionTitle)
      verdicts.push({ sectionTitle, cohesive: true, issue: '' })
      continue
    }

    if (/^revise\b/i.test(status)) {
      const issue = parts.slice(2).join(' | ').trim()
      seen.add(sectionTitle)
      verdicts.push({ sectionTitle, cohesive: false, issue })
    }
    // Any other status is malformed output: skip the line
  }

  return verdicts
}

// Chooses which sections to rewrite and what each rewrite must achieve.
// Sections the review flagged come first, since a cohesion break is a real
// defect; when the script is also off target and rewrite slots remain, the
// sections with the most room take a share of the correction — shortest first
// when the script is short, longest first when it runs long. A length
// correction is spread across every chosen section so no single one is asked
// for an implausible rewrite.
export function selectScriptRevisions(
  verdicts: ScriptReviewVerdict[],
  sections: DocumentSection[],
  assessment: LengthAssessment,
  cap: number = MAX_SCRIPT_REVIEW_REVISIONS
): ScriptRevision[] {
  const wordsByTitle = new Map(assessment.sections.map(section => [section.title, section.wordCount]))
  const known = new Set(sections.map(section => section.title))

  const chosen: ScriptRevision[] = []
  const take = (sectionTitle: string, issue?: string) => {
    if (chosen.length >= cap) return
    if (chosen.some(revision => revision.sectionTitle === sectionTitle)) return
    chosen.push({ sectionTitle, currentWords: wordsByTitle.get(sectionTitle) ?? 0, issue })
  }

  for (const verdict of verdicts) {
    if (!verdict.cohesive && known.has(verdict.sectionTitle)) {
      take(verdict.sectionTitle, verdict.issue)
    }
  }

  if (assessment.status !== 'on-target') {
    const byRoom = [...assessment.sections].sort((a, b) =>
      assessment.status === 'short' ? a.wordCount - b.wordCount : b.wordCount - a.wordCount
    )
    for (const section of byRoom) {
      take(section.title)
    }

    // Every chosen section carries an equal share of the shortfall or excess
    const share = Math.round(assessment.wordsToTarget / chosen.length)
    for (const revision of chosen) {
      revision.wordTarget = Math.min(
        REVISION_MAX_WORDS,
        Math.max(REVISION_MIN_WORDS, revision.currentWords + share)
      )
    }
  }

  return chosen
}

// The revision phrased as an instruction for the existing
// section-regeneration path, which already supplies the outline entry and the
// surrounding sections for continuity
export function buildScriptRevisionInstruction(
  revision: ScriptRevision,
  plan: LengthPlan = buildLengthPlan()
): string {
  const parts: string[] = []

  if (revision.issue) {
    parts.push(
      'A whole-script review found this section does not sit right in the arc: ' +
      `${revision.issue} Rewrite it so it follows on from the section before it and sets up the one after.`
    )
  }

  if (revision.wordTarget) {
    const direction = revision.wordTarget > revision.currentWords ? 'expand' : 'tighten'
    parts.push(
      `The finished script is ${direction === 'expand' ? 'shorter' : 'longer'} than its ` +
      `${plan.targetMinutes} minute spoken target, so ${direction} this section ` +
      `from ${revision.currentWords} to approximately ${revision.wordTarget} words. ` +
      (direction === 'expand'
        ? 'Develop what is already here — deepen the suggestions, let the pacing breathe — rather than padding or repeating.'
        : 'Cut repetition and ground already covered rather than removing anything the arc depends on.')
    )
  }

  parts.push('Keep the section\'s role and position in the script unchanged.')

  return parts.join(' ')
}

// Why a section was rewritten, short enough for the summary banner
export function describeRevisionReason(revision: ScriptRevision): string {
  if (revision.issue && revision.wordTarget) return 'cohesion and length'
  if (revision.issue) return 'cohesion'
  return 'length'
}

// The one-line, human-readable outcome of the pass. The assessment passed in
// should be of the script as it stands after any rewrites, so the reported
// length is the length the user now has.
export function formatScriptReviewSummary(
  revised: ReviewRevision[],
  assessment: LengthAssessment
): string {
  const length = `${assessment.totalWords.toLocaleString('en-US')} words · ~${assessment.minutes} min`
  const lengthNote = assessment.status === 'on-target'
    ? `${length}, close to the ${assessment.plan.targetMinutes} minute target`
    : `${length}, still ${assessment.status === 'short' ? 'under' : 'over'} the ` +
      `${assessment.plan.targetMinutes} minute target`

  if (revised.length === 0) {
    return `Review found no cohesion problems — ${lengthNote}.`
  }

  const details = revised
    .map(entry => entry.reason ? `${entry.sectionTitle} (${entry.reason})` : entry.sectionTitle)
    .join(', ')

  return `Review rewrote ${revised.length} ${revised.length === 1 ? 'section' : 'sections'}: ` +
    `${details}. Now ${lengthNote}.`
}
