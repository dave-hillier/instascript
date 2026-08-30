import type {
  CritiqueFinding,
  CritiqueRecord,
  CritiqueSpan,
  ReviewReport,
  ReviewRevision
} from '../types/conversation'
import type { CritiqueStage, CritiqueVerdictName } from './writingTools'
import { CRITIQUE_STAGES } from './writingTools'
import { isStyleRuleNumber, styleRuleRange } from './prompts'
import { resolveSpan, SPAN_MIN_CHARS, SPAN_QUOTE_MAX } from './span'

// Story 8.5: the optional style-review pass. Pure logic for reading a
// critique — as a critique_record tool call, or as the older line-oriented
// prose a model that cannot call tools still replies with — for deciding what
// a critique is allowed to claim, and for describing the outcome. The critique
// prompt itself reuses the style rules from style-rules.txt (see
// buildStyleCritiquePrompt in prompts.ts) so the rules live in exactly one
// place — the file a script is written against is the file it is judged
// against.
//
// THE PASS MARKS, IT DOES NOT REVISE. It used to rewrite up to two violating
// sections on its own authority, before the reader had seen either the
// violation or the words it replaced. It no longer rewrites anything: it
// records a verdict and findings that quote the passage at fault, and the
// reader decides what to act on. Quoting the passage is what makes disagreeing
// with the finding possible, and a pass that had already spent the rewrite
// would have spent the disagreement with it.

// How many sections one critique may name. Marking is cheap — nothing is
// regenerated — so the cap is no longer the cost bound MAX_REVIEW_REVISIONS
// was; it is a discrimination bound. A pass that finds fault with every
// section of a script has stopped judging and started listing, and a reader
// facing a mark on everything has been told nothing.
export const MAX_CRITIQUE_FINDINGS = 6

// How many passages one finding may quote. A finding is about one section and
// carries one reason, so the spans exist to point at the worst of it rather
// than to enumerate it.
export const MAX_SPANS_PER_FINDING = 3

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

const formatRuleNumbers = (ruleNumbers: number[]): string =>
  ruleNumbers.length === 1
    ? `rule ${ruleNumbers[0]}`
    : ruleNumbers.length > 1
      ? `rules ${ruleNumbers.join(', ')}`
      : 'the style rules'

// The one-line, human-readable outcome of the pass, e.g.
// "Style review marked 2 sections: Deepening (rule 6), Awakening (rule 9)."
//
// It says MARKED and not "revised" because nothing was revised: the sections
// named still read exactly as the reader left them, and the findings are there
// to be read and acted on or dismissed. A summary claiming a rewrite that did
// not happen would be the one sentence on the page a reader cannot check.
export function formatReviewSummary(revised: ReviewRevision[]): string {
  if (revised.length === 0) {
    return 'Style review passed: every section follows the style rules.'
  }
  const details = revised
    .map(entry => `${entry.sectionTitle} (${formatRuleNumbers(entry.ruleNumbers ?? [])})`)
    .join(', ')
  return `Style review marked ${revised.length} ${revised.length === 1 ? 'section' : 'sections'}: ${details}.`
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

// --- the critique_record acceptance rules --------------------------------
//
// Pure functions over explicit inputs, so the rule deciding what a critique
// may claim is testable without a live model.

// One finding as the model's call carries it: spans are still the raw strings
// it typed, and nothing has been checked yet.
export interface CritiqueFindingArgs {
  section: string
  rules?: number[]
  spans?: string[]
  reason: string
}

// One written section as the acceptance rules need it: the body every span is
// measured against, and the replacement count recorded with the spans that
// pinned to it.
export interface CritiqueSectionBody {
  readonly body: string
  readonly revisions: number
}

// Accepted, or refused with the sentence the model is sent back. A refusal is
// a TOOL RESULT, exactly as a section of the wrong length is: the call is
// answered with what was wrong, and the model calls again. It is never an
// error that fails the round, and never a second prose-shaped protocol beside
// the one the section loop already uses.
export type CritiqueAcceptance =
  | { ok: true; critique: CritiqueRecord }
  | { ok: false; reason: string }

const refuse = (reason: string): CritiqueAcceptance => ({ ok: false, reason: `REFUSED: ${reason}` })

// Quote a rejected value back at a length a tool result can carry
const clip = (quote: string): string => (quote.length <= 60 ? quote : `${quote.slice(0, 60)}…`)

export const isCritiqueStage = (value: unknown): value is CritiqueStage =>
  typeof value === 'string' && (CRITIQUE_STAGES as readonly string[]).includes(value)

export const isCritiqueVerdict = (value: unknown): value is CritiqueVerdictName =>
  value === 'pass' || value === 'revise'

// The arguments of a critique_record call, read out of the JSON the provider
// streamed. Returns null for anything that is not a critique at all — bad
// JSON, an unknown stage, a verdict that is neither — because there is nothing
// there to refuse a detail of. Everything that IS a critique, however wrong,
// comes back as arguments so acceptCritique can name what is wrong with it.
export interface CritiqueCallArgs {
  stage: CritiqueStage
  verdict: CritiqueVerdictName
  findings: CritiqueFindingArgs[]
}

export function parseCritiqueToolCall(argumentsJson: string): CritiqueCallArgs | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (!isCritiqueStage(record.stage)) return null
  if (!isCritiqueVerdict(record.verdict)) return null

  const rawFindings = Array.isArray(record.findings) ? record.findings : []
  const findings: CritiqueFindingArgs[] = []
  for (const entry of rawFindings) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const finding = entry as Record<string, unknown>
    findings.push({
      section: typeof finding.section === 'string' ? finding.section : '',
      // Numbers only, and the non-numbers are dropped rather than coerced: a
      // rule cited as "6" is a citation, and one cited as null is nothing
      ...(Array.isArray(finding.rules)
        ? { rules: finding.rules.filter((rule): rule is number => typeof rule === 'number') }
        : {}),
      ...(Array.isArray(finding.spans)
        ? { spans: finding.spans.filter((span): span is string => typeof span === 'string') }
        : {}),
      reason: typeof finding.reason === 'string' ? finding.reason : ''
    })
  }

  return { stage: record.stage, verdict: record.verdict, findings }
}

// Pin one finding's quoted passages to the body it names.
//
// The spans are resolved HERE, against the body as it stands at this instant,
// because this is the only moment at which the claim and the text are both in
// hand. The recorded quote is always the body's own slice, so a finding that
// was accepted can always be re-found; one that was mistyped never enters the
// record at all, because the call carrying it was refused.
//
// The uniqueness rule has a cost worth naming: a repetition finding, where the
// fault IS that a phrase recurs, cannot be one span. It records several
// instead, each extended into its own surrounding words — which is what a
// reader wants underlined anyway.
const acceptSpans = (
  section: string,
  body: string,
  spans: readonly string[]
): { ok: true; spans: CritiqueSpan[] } | { ok: false; reason: string } => {
  if (spans.length > MAX_SPANS_PER_FINDING) {
    return {
      ok: false,
      reason:
        `REFUSED: a finding may quote at most ${MAX_SPANS_PER_FINDING} passages, not ` +
        `${spans.length}; keep the worst and say the rest in the reason.`
    }
  }

  const accepted: CritiqueSpan[] = []
  for (const span of spans) {
    const resolution = resolveSpan(body, span)
    if (resolution.ok) {
      accepted.push({ ...resolution.anchor })
      continue
    }
    // Each fault is named, not merely reported, so the model can fix the quote
    // rather than guess at what "invalid" meant.
    if (resolution.fault === 'empty') {
      return { ok: false, reason: 'REFUSED: every quoted span must contain words; drop the empty one.' }
    }
    if (resolution.fault === 'short') {
      return {
        ok: false,
        reason:
          `REFUSED: the span "${clip(span)}" is ${resolution.chars} characters, and a span must be ` +
          `at least ${SPAN_MIN_CHARS}; extend it with the words around it so it names a passage ` +
          'rather than a word that recurs.'
      }
    }
    if (resolution.fault === 'long') {
      return {
        ok: false,
        reason:
          `REFUSED: that span is ${resolution.chars} characters, and a span may be at most ` +
          `${SPAN_QUOTE_MAX}; quote the phrase at fault, not the paragraph around it.`
      }
    }
    if (resolution.fault === 'absent') {
      return {
        ok: false,
        reason:
          `REFUSED: "${clip(span)}" was not found in "${section}"; quote the passage character ` +
          'for character as the section now reads, or drop the span and let the reason carry the ' +
          'finding.'
      }
    }
    return {
      ok: false,
      reason:
        `REFUSED: "${clip(span)}" is ambiguous — it appears ${resolution.matches} times in ` +
        `"${section}"; extend the quote at either end until it names one passage.`
    }
  }

  return { ok: true, spans: accepted }
}

// Accept or refuse one critique.
//
// `bodies` is required rather than defaulted: an empty map turns every span
// refusal into "that section has no body", which would hide a wiring bug
// behind a plausible message.
export function acceptCritique(
  bodies: ReadonlyMap<string, CritiqueSectionBody>,
  stage: CritiqueStage,
  verdict: CritiqueVerdictName,
  findings: readonly CritiqueFindingArgs[]
): CritiqueAcceptance {
  if (verdict === 'pass' && findings.length > 0) {
    return refuse('a passing critique records no findings; use verdict "revise" to name a fault.')
  }
  if (verdict === 'revise' && findings.length === 0) {
    return refuse('a revising critique must name at least one finding; use verdict "pass" to approve.')
  }
  if (findings.length > MAX_CRITIQUE_FINDINGS) {
    return refuse(
      `a critique may record at most ${MAX_CRITIQUE_FINDINGS} findings, not ${findings.length}; ` +
      'keep the worst and drop the rest.'
    )
  }

  const seen = new Set<string>()
  const accepted: CritiqueFinding[] = []

  for (const finding of findings) {
    if (finding.section.trim().length === 0 || finding.reason.trim().length === 0) {
      return refuse('every finding needs a section title and a reason.')
    }
    if (seen.has(finding.section)) {
      return refuse(`"${finding.section}" is named twice; give one section one finding.`)
    }
    seen.add(finding.section)

    // A citation has to resolve. getStyleRules() is the one numbered list, so
    // a finding citing "rule 27" against a list of fourteen is a fabricated
    // criterion rather than a judgement — and once recorded it rides into the
    // reading view where nothing can tell it from a real one.
    const rules = finding.rules
    if (rules !== undefined && rules.some(rule => !isStyleRuleNumber(rule))) {
      return refuse(
        `rule numbers must name a style rule (${styleRuleRange()}); ` +
        `"${finding.section}" cites ${rules.join(', ')}.`
      )
    }

    const claimed = finding.spans ?? []
    const written = bodies.get(finding.section)
    if (claimed.length > 0 && written === undefined) {
      return refuse(
        `"${finding.section}" has no written body, so there is nothing in it to quote; ` +
        'record the finding without spans, or name a section that is written.'
      )
    }

    let spans: CritiqueSpan[] | undefined
    if (written !== undefined && claimed.length > 0) {
      const resolved = acceptSpans(finding.section, written.body, claimed)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }
      spans = resolved.spans.length > 0 ? resolved.spans : undefined
    }

    accepted.push({
      section: finding.section,
      // A key present with nothing under it is a claim a reader would have to
      // interpret, so an empty list records no key at all
      ...(rules === undefined || rules.length === 0 ? {} : { rules: [...rules] }),
      ...(spans === undefined ? {} : { spans, revisions: written?.revisions ?? 0 }),
      reason: finding.reason
    })
  }

  return { ok: true, critique: { stage, verdict, findings: accepted } }
}

// The critique read back for the model as text, so what it just recorded is in
// the transcript and not only in the stored record.
//
// The spans are printed as they were PINNED, not as they were typed: a model
// that quoted across a line break sees the body's own words come back, which
// is the only way it learns what its mark actually covers.
export function renderCritique(critique: CritiqueRecord): string {
  if (critique.verdict === 'pass') {
    return `The ${critique.stage} pass approved the script; nothing is marked. Stop here.`
  }
  const lines = critique.findings.flatMap(finding => [
    `- ${finding.section}` +
    `${finding.rules === undefined ? '' : ` (${formatRuleNumbers(finding.rules)})`}: ${finding.reason}`,
    ...(finding.spans ?? []).map(span => `  · "${span.quote}"`)
  ])
  return [
    `The ${critique.stage} pass marked ${critique.findings.length} ` +
    `${critique.findings.length === 1 ? 'section' : 'sections'}. Nothing has been rewritten: ` +
    'the reader decides what to act on. Stop here.',
    ...lines
  ].join('\n')
}

// The older line-oriented verdicts as findings, for a model that replied in
// prose rather than calling the tool.
//
// They carry NO SPANS, and cannot: a VERDICT line names a section and a rule
// number, and nothing in it points at a passage. That is precisely the
// difference the tool exists to make, and the fallback is deliberately the
// weaker record rather than a place to guess a quote from — an invented span
// would be indistinguishable from one the model actually read off the body.
// Verdicts naming a section the script does not have are dropped, and an
// invented rule number is dropped with the rest of its citation, on the same
// terms the tool refuses one.
export function findingsFromVerdicts(
  verdicts: readonly CritiqueVerdict[],
  sectionTitles: readonly string[]
): CritiqueFinding[] {
  const known = new Set(sectionTitles)
  return verdicts
    .filter(verdict => !verdict.compliant && known.has(verdict.sectionTitle))
    .slice(0, MAX_CRITIQUE_FINDINGS)
    .map(verdict => {
      const rules = verdict.ruleNumbers.filter(isStyleRuleNumber)
      return {
        section: verdict.sectionTitle,
        ...(rules.length > 0 ? { rules } : {}),
        reason: verdict.reason || 'The style review marked this section without saying why.'
      }
    })
}

// The findings as the ReviewReport's entries. The page reads `revised`, and
// what it now lists is what the pass MARKED — see ReviewRevision.
export function reviewRevisionsFromFindings(findings: readonly CritiqueFinding[]): ReviewRevision[] {
  return findings.map(finding => ({
    sectionTitle: finding.section,
    ...(finding.rules && finding.rules.length > 0 ? { ruleNumbers: [...finding.rules] } : {}),
    ...(finding.reason ? { reason: finding.reason } : {})
  }))
}
