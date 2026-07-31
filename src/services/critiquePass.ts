import type { ReviewReport, ReviewRevision } from '../types/conversation'

// Story 8.5: the optional style-review pass. Pure logic for parsing the
// critique response, choosing which sections to revise, and describing the
// outcome. The critique prompt itself reuses the style rules from
// hypnosis-system.txt (see buildStyleCritiquePrompt in prompts.ts) so the
// rules live in exactly one place.

// Revisions per run are capped to bound the extra cost of the pass
export const MAX_REVIEW_REVISIONS = 2

// Marker used as the RegenerationRequest section title for the critique
// request itself; real providers ignore it, and the mock uses it to return
// a critique-shaped response.
export const STYLE_REVIEW_SECTION_TITLE = '__style_review__'

export interface CritiqueVerdict {
  sectionTitle: string
  compliant: boolean
  ruleNumbers: number[]
  reason: string
}

// Parses the line-oriented critique format:
//   VERDICT: <title> | compliant
//   VERDICT: <title> | violates 6, 9 | <reason>
// Anything that does not fit the format is skipped, and the first verdict
// per section wins, so preamble, commentary or repeated lines from a
// less obedient model are tolerated.
export function parseCritiqueResponse(text: string): CritiqueVerdict[] {
  const verdicts: CritiqueVerdict[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split('\n')) {
    const match = rawLine.match(/^\s*(?:[-*]\s*)?VERDICT:\s*(.+)$/i)
    if (!match) continue

    const parts = match[1].split('|').map(part => part.trim())
    if (parts.length < 2) continue

    const sectionTitle = parts[0].replace(/^["']+|["']+$/g, '').trim()
    if (!sectionTitle || seen.has(sectionTitle)) continue

    const status = parts[1]
    if (/^compliant$/i.test(status)) {
      seen.add(sectionTitle)
      verdicts.push({ sectionTitle, compliant: true, ruleNumbers: [], reason: '' })
      continue
    }

    if (/^violates\b/i.test(status)) {
      const ruleNumbers = [...new Set((status.match(/\d+/g) ?? []).map(Number))]
      const reason = parts.slice(2).join(' | ').trim()
      seen.add(sectionTitle)
      verdicts.push({ sectionTitle, compliant: false, ruleNumbers, reason })
    }
    // Any other status is malformed output: skip the line
  }

  return verdicts
}

// The violating sections that actually exist in the script, capped so one
// review never triggers more than MAX_REVIEW_REVISIONS regenerations
export function selectViolationsToRevise(
  verdicts: CritiqueVerdict[],
  sectionTitles: string[]
): CritiqueVerdict[] {
  const known = new Set(sectionTitles)
  return verdicts
    .filter(verdict => !verdict.compliant && known.has(verdict.sectionTitle))
    .slice(0, MAX_REVIEW_REVISIONS)
}

const formatRuleNumbers = (ruleNumbers: number[]): string =>
  ruleNumbers.length === 1
    ? `rule ${ruleNumbers[0]}`
    : ruleNumbers.length > 1
      ? `rules ${ruleNumbers.join(', ')}`
      : 'the style rules'

// The violation phrased as an instruction for the existing
// section-regeneration path
export function buildRevisionInstruction(verdict: CritiqueVerdict): string {
  const rules = verdict.ruleNumbers.length > 0
    ? `style ${formatRuleNumbers(verdict.ruleNumbers)}`
    : 'the style rules'
  const reason = verdict.reason ? `: ${verdict.reason}` : ''
  return `A style review found the previous version of this section violates ${rules}${reason}. ` +
    'Rewrite the section so it fully complies with the style rules while keeping its role in the script.'
}

// The one-line, human-readable outcome of the pass, e.g.
// "Review revised 2 sections: Deepening (rule 6), Awakening (rule 9)."
export function formatReviewSummary(revised: ReviewRevision[]): string {
  if (revised.length === 0) {
    return 'Style review passed: every section follows the style rules.'
  }
  const details = revised
    .map(entry => `${entry.sectionTitle} (${formatRuleNumbers(entry.ruleNumbers ?? [])})`)
    .join(', ')
  return `Review revised ${revised.length} ${revised.length === 1 ? 'section' : 'sections'}: ${details}.`
}

// A review summary describes a particular set of sections. Once the script has
// been restructured under it — a section added, removed, renamed or reordered —
// it is reporting on a script that no longer exists, so it is retired rather
// than left on screen. Reports from before structures were recorded are trusted
// as-is, having nothing to compare against.
export function reviewReportDescribesStructure(
  report: Pick<ReviewReport, 'structure'>,
  sectionTitles: string[]
): boolean {
  if (!report.structure) return true
  return report.structure.length === sectionTitles.length &&
    report.structure.every((title, i) => title === sectionTitles[i])
}
