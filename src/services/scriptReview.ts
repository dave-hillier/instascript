import type { CritiqueFinding, ReviewRevision } from '../types/conversation'
import type { DocumentSection } from './conversationDocument'
import { countWords, estimateSpokenMinutes } from '../utils/scriptMetrics'
import { MAX_CRITIQUE_FINDINGS } from './critiquePass'
import { buildLengthPlan } from './scriptLength'
import type { LengthPlan } from './scriptLength'

// Story 8.14: the on-demand whole-script review. Where the style pass (8.5)
// judges each section against the numbered style rules in isolation, this pass
// judges the script as one artifact: does it read as a single narrative arc,
// and is it the length it is supposed to be? Pure logic lives here; the
// request itself is buildScriptReviewPrompt in prompts.ts.
//
// THIS PASS MARKS, IT DOES NOT REVISE — the same decision the style pass was
// held to, and for the same reason. It used to rewrite up to three sections on
// its own authority: a reader who pressed "review" on a script they had just
// read got back a script with different words in it and a one-line summary of
// why. It now records what it found, quoting the passages, and the reader
// decides. Being a button the reader pressed is not consent to a rewrite —
// they asked what an editor thinks, and an editor who silently retypes the
// page has answered a different question.
//
// The length correction went with the rewrites, deliberately: it was a rewrite
// instruction and nothing else, so keeping it would have meant marking a
// section and then replacing the very passage the mark quotes. The measured
// length is still judged, still stated to the model as fact, and still
// reported in the summary — as something the reader is told rather than
// something spent on their behalf.

// Marker used as the RegenerationRequest section title for the review request
// itself; real providers ignore it, and the mock uses it to return a
// review-shaped response.
export const SCRIPT_REVIEW_SECTION_TITLE = '__script_review__'

export type LengthStatus = 'short' | 'on-target' | 'long'

export interface LengthAssessment {
  // The length this script was asked for, so every judgement and every line of
  // reporting is against the target the user picked rather than a fixed one
  plan: LengthPlan
  totalWords: number
  minutes: number
  status: LengthStatus
  // Words to add (positive) or cut (negative) to reach the target itself,
  // rather than the nearest edge of its window: the number the reader is told
  // is the distance to what they asked for.
  wordsToTarget: number
  sections: { title: string; wordCount: number }[]
}

export interface ScriptReviewVerdict {
  sectionTitle: string
  cohesive: boolean
  // What the review says is wrong with this section
  issue: string
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
//   VERDICT: <title> | revise | <what is wrong with the section>
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

// The findings of a prose review: one per section the review would not call
// cohesive, carrying what it said is wrong. They quote NOTHING, for the reason
// findingsFromVerdicts gives next door — a VERDICT line names a section and
// points at no passage, and a span invented here would be indistinguishable
// from one read off the body. Verdicts naming a section the script does not
// have are dropped.
export function findingsFromReviewVerdicts(
  verdicts: readonly ScriptReviewVerdict[],
  sectionTitles: readonly string[]
): CritiqueFinding[] {
  const known = new Set(sectionTitles)
  return verdicts
    .filter(verdict => !verdict.cohesive && known.has(verdict.sectionTitle))
    .slice(0, MAX_CRITIQUE_FINDINGS)
    .map(verdict => ({
      section: verdict.sectionTitle,
      reason: verdict.issue || 'The review marked this section without saying why.'
    }))
}

// The one-line, human-readable outcome of the pass.
//
// It says MARKED and not "rewrote": the sections it names still read exactly
// as the reader left them. The length is reported beside the marks because the
// pass measured it and the reader has not been told otherwise — it is now the
// only thing the review does about length.
export function formatScriptReviewSummary(
  marked: ReviewRevision[],
  assessment: LengthAssessment
): string {
  const length = `${assessment.totalWords.toLocaleString('en-US')} words · ~${assessment.minutes} min`
  const lengthNote = assessment.status === 'on-target'
    ? `${length}, close to the ${assessment.plan.targetMinutes} minute target`
    : `${length}, ${assessment.status === 'short' ? 'under' : 'over'} the ` +
      `${assessment.plan.targetMinutes} minute target`

  if (marked.length === 0) {
    return `Review found no cohesion problems — ${lengthNote}.`
  }

  const details = marked
    .map(entry => entry.reason ? `${entry.sectionTitle} (${entry.reason})` : entry.sectionTitle)
    .join(', ')

  return `Review marked ${marked.length} ${marked.length === 1 ? 'section' : 'sections'}: ` +
    `${details}. Nothing was rewritten — ${lengthNote}.`
}
