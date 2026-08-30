// What a marked section looks like, decided here rather than in the component.
//
// Everything the reading view has to work out about marks is worked out in
// this file: which passages are still there, where they sit in the body as it
// now reads, how overlapping marks divide the text between them, what each
// mark is called, and what spending one would cost. ScriptDocument renders
// what comes back and decides nothing, which is the only way any of this can
// be tested in the node environment the suite runs in — the same arrangement
// sectionStatusNote already uses for the length waiver.
//
// The runs are the interesting part. Two marks may cover overlapping passages —
// a style finding about a whole sentence and a reader's flag on three words
// inside it — and nested highlights would have to be either nested elements,
// which no accessible name can describe, or one mark silently winning. Instead
// the body is cut at every mark boundary and each resulting run says which
// marks cover it. An overlap becomes one run belonging to two marks, drawn as
// such, and nothing is hidden.

import {
  reanchorSpan,
  SPAN_MIN_CHARS,
  SPAN_QUOTE_MAX,
  type SpanAnchor,
  type SpanAnchorState,
  type SpanResolution
} from './span'
import { sectionRevisions, type ProjectedFinding, type ProjectedSection } from './scriptProjection'
import { findingKey, type ReaderFlag } from './markStore'

// Who made the mark. It decides what can be done with it, not just how it
// looks: a finding belongs to the run and the reader may show, spend or
// dismiss it but never reword it, while a flag is the reader's own note and
// its label and annotation are theirs.
export type MarkKind = 'finding' | 'flag'

// How well the marked passage was found in the body as it now reads.
export type MarkPlacement =
  | SpanAnchorState
  // The finding quoted no passage at all: a prose critique names a section,
  // and a finding about a section nobody has written yet can quote nothing.
  | 'unquoted'
  // The section is being written right now. Its body is a fragment, so a
  // passage found in it means nothing and a passage missing from it proves
  // nothing (M4).
  | 'unsettled'

export interface MarkRange {
  start: number
  end: number
}

// One mark as the reading view needs it.
export interface SectionMark {
  // Identity within the rendered page, safe to use as an element id. Derived
  // from `key`, never from the mark's position — see markRenderId.
  id: string
  // Identity in the store: a flag's own id, or a finding's key. This is what
  // an event carries; `id` never leaves the render.
  key: string
  kind: MarkKind
  // Title of the section the mark is against, or the title the finding named
  // when no such section exists.
  section: string
  // Short name: the rules a finding cites, or the reader's own label.
  label: string
  // Who made the mark, in the words the panel shows. Decided here because a
  // finding can come from any judging pass and the wording differs per pass;
  // a component saying "from the style pass" for all of them would mislabel a
  // review or outline note.
  origin: string
  // The longer sentence: a finding's reason, or the reader's note.
  reason: string
  // The passages, verbatim as they were recorded, for a panel that has to show
  // the reader what the mark is about when the highlight cannot be drawn.
  quotes: string[]
  // Where to draw it, in offsets into the section's content. Empty whenever
  // the placement is anything but 'anchored' or 'shifted'.
  ranges: MarkRange[]
  placement: MarkPlacement
  // The section's body has been replaced since this mark was recorded, so the
  // passage it names may have been repaired by a rewrite that was never about
  // this mark at all.
  rewrittenSince: boolean
  // The instruction a rewrite would carry, were the mark spent.
  instruction: string
  // What spending it would cost, said before it is spent.
  spendNote: string
  // Whether a rewrite can actually be asked for on this mark right now: there
  // is a section to rewrite, and the document is not being written under it.
  // Spending during a run is hidden rather than queued, because a rewrite
  // asked for against a body that is being replaced is exactly the silent
  // wrongness this feature exists to remove (M4).
  spendable: boolean
  // The key of the run element the mark's highlight begins in, when it is
  // drawn at all. This is what the panel points at, and what the reading view
  // scrolls to; it is not the mark's own id, because one mark can be cut
  // across several runs by another mark overlapping it.
  anchorRunKey?: string
}

// A stretch of body text and the marks covering it. No marks means plain text.
export interface MarkRun {
  key: string
  text: string
  markIds: string[]
  // What is covering this run, so the component can style it without looking
  // any marks up: a run covered by both kinds is drawn as both.
  tone: 'plain' | 'finding' | 'flag' | 'both'
  // Whether the mark the reader asked to be shown covers this run. Decided
  // here with the mark ids in hand rather than in the component, where the
  // comparison had to invent a stand-in for "nothing focused".
  focused: boolean
  // What a screen reader is told when it reaches this stretch of text.
  //
  // A <mark> is neither focusable nor interactive, so an aria-describedby on
  // it is not surfaced by assistive tech; the relationship has to be in text.
  // Rendered as visually hidden words inside the mark. Empty for a run
  // nothing covers, which is announced as the plain prose it is.
  announcement: string
}

export interface MarkedParagraph {
  key: string
  runs: MarkRun[]
}

export interface SectionMarkView {
  // The section's body as the view renders it: the paragraphs it already drew,
  // each cut into runs. A section with no marks comes back as one run per
  // paragraph, which is exactly what it rendered before marks existed.
  paragraphs: MarkedParagraph[]
  marks: SectionMark[]
}

export interface DocumentMarkView {
  // Keyed by section title, which is what the projection keys sections by.
  bySection: Record<string, SectionMarkView>
  // Every mark in the document, in reading order, with the ones naming a
  // section that does not exist last.
  marks: SectionMark[]
}

// The section fields a mark view needs. Narrower than ProjectedSection so a
// test can build one without inventing a whole projection.
export type MarkableSection = Pick<
  ProjectedSection,
  'id' | 'title' | 'content' | 'revisions' | 'isLive'
>

export interface MarkViewInput {
  sections: readonly MarkableSection[]
  findings: readonly ProjectedFinding[]
  flags: readonly ReaderFlag[]
  dismissed: readonly string[]
  // Findings the reader already paid a rewrite for. Hidden like a dismissal
  // but not restorable: the body the finding quoted has been replaced.
  spent: readonly string[]
  // Whether a rewrite can be asked for at all right now — false while a
  // generation is in flight, and when there is no conversation to ask through.
  canSpend: boolean
  // The mark the reader asked to be shown, if any.
  focusedMarkId: string | null
}

// A body line that the reading view does not draw: the section's own heading,
// which the header already shows, and blank lines between paragraphs.
const isRenderedLine = (line: string): boolean =>
  !line.startsWith('## ') && line.trim() !== ''

interface BodyParagraph {
  text: string
  start: number
  key: string
}

// The paragraphs the view draws, each with where it begins in the content.
// Offsets are kept because every mark is measured against the whole body, and
// a paragraph that did not know where it started would draw its highlights in
// the wrong place.
const bodyParagraphs = (content: string): BodyParagraph[] => {
  const paragraphs: BodyParagraph[] = []
  let start = 0
  content.split('\n').forEach((line, index) => {
    if (isRenderedLine(line)) {
      paragraphs.push({ text: line, start, key: `line-${index}` })
    }
    start += line.length + 1
  })
  return paragraphs
}

// One 32-bit FNV-1a pass over the key, with the seed left open so the same
// text can be hashed twice into two independent halves.
const fnv1a = (text: string, seed: number): number => {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  }
  return hash >>> 0
}

// A mark's identity in the rendered page.
//
// Derived from the mark's identity in the store — a flag's own id, a finding's
// key — and never from where the mark sits in the list. The list reorders as
// passages move and shortens as marks are dismissed or spent, and an id that
// counted positions would name a DIFFERENT mark after either: "Show" would
// scroll to the wrong passage, and an open rename form would jump onto another
// mark and save the reader's label onto it.
//
// The key cannot be the id as it stands. A finding's key is built from the
// model's own prose and a unit separator, and an id has to survive being
// written into an attribute and read back out of a space-separated token list.
// So the key is hashed twice, with different seeds, giving 64 bits: two marks
// on one script colliding in both halves is not a risk worth code.
export const markRenderId = (key: string): string =>
  `mark_${fnv1a(key, 0x811c9dc5).toString(36)}${fnv1a(key, 0x9e3779b1).toString(36)}`

const ordinal = (value: number): string => {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  switch (value % 10) {
    case 1: return `${value}st`
    case 2: return `${value}nd`
    case 3: return `${value}rd`
    default: return `${value}th`
  }
}

// What spending a mark would cost, in the terms the reader can actually judge:
// how many times this body has already been replaced, and which rewrite this
// would be. Shown on the button before it is pressed, because a section on its
// fourth rewrite is a different proposition from one on its first.
export const spendCostNote = (section: MarkableSection): string => {
  const written = sectionRevisions(section)
  return written === 0
    ? `A first rewrite of "${section.title}"`
    : `The ${ordinal(written + 1)} rewrite of "${section.title}" — it has been rewritten ${written === 1 ? 'once' : `${written} times`} already`
}

// The name a finding goes by. The style rules it cites when it cites any,
// because a numbered rule is the most specific thing a reader can check the
// finding against; the pass that made it otherwise.
export const findingLabel = (finding: ProjectedFinding): string => {
  const rules = finding.rules ?? []
  if (rules.length === 1) return `Style rule ${rules[0]}`
  if (rules.length > 1) return `Style rules ${rules.join(', ')}`
  switch (finding.stage) {
    case 'outline': return 'Outline note'
    case 'review': return 'Review note'
    default: return 'Style note'
  }
}

// Who made a finding, in the words the panel shows. Every stage critique_record
// accepts is named, because a review note labelled as a style note tells the
// reader to check it against the style rules, which is not what it was.
export const findingOrigin = (finding: ProjectedFinding): string => {
  switch (finding.stage) {
    case 'outline': return 'From the outline pass'
    case 'review': return 'From the review pass'
    default: return 'From the style pass'
  }
}

// What the reader needs told about a mark that is not simply sitting on its
// passage, or null when it is. Never silent about a mark it could not draw: a
// mark that quietly disappeared would leave the reader believing a passage was
// repaired when nobody touched it.
export const markPlacementNote = (mark: SectionMark): string | null => {
  switch (mark.placement) {
    case 'unsettled':
      return 'This section is being written; its marks are set aside until it settles.'
    case 'unquoted':
      return 'This finding names the section but quotes no passage in it.'
    case 'stale':
      return mark.rewrittenSince
        ? 'The passage is gone from this section, which has been rewritten since the mark was made.'
        : 'The passage is no longer in this section.'
    case 'shifted':
      return 'The words around this passage have changed; this is the only copy of it left.'
    default:
      return mark.rewrittenSince
        ? 'The section has been rewritten since the mark was made, and the passage survived it.'
        : null
  }
}

// The instruction a spend sends, which is an ordinary section rewrite
// instruction and nothing new: the quoted passage, and why it was marked.
const spendInstruction = (label: string, reason: string, quotes: string[]): string => {
  const passages = quotes.map(quote => `"${quote}"`).join(' and ')
  const named = passages === '' ? 'this section' : `this passage: ${passages}`
  return `${label}. Rewrite ${named} — ${reason}`
}

// A mark before it knows its place in the document's order.
type DraftMark = Omit<SectionMark, 'id'>

const placeAnchors = (
  content: string,
  anchors: readonly SpanAnchor[]
): { ranges: MarkRange[]; placement: SpanAnchorState } => {
  const ranges: MarkRange[] = []
  let anyShifted = false
  for (const anchor of anchors) {
    const placed = reanchorSpan(content, anchor)
    if (placed.state === 'stale') continue
    if (placed.state === 'shifted') anyShifted = true
    ranges.push({ start: placed.start, end: placed.end })
  }
  ranges.sort((left, right) => left.start - right.start)
  if (ranges.length === 0) return { ranges, placement: 'stale' }
  return { ranges, placement: anyShifted ? 'shifted' : 'anchored' }
}

const draftFinding = (
  finding: ProjectedFinding,
  section: MarkableSection | undefined,
  canSpend: boolean
): DraftMark => {
  const label = findingLabel(finding)
  const quotes = (finding.spans ?? []).map(span => span.quote)
  const rewrittenSince = section !== undefined &&
    finding.revisions !== undefined &&
    finding.revisions !== sectionRevisions(section)

  const placed = section === undefined || finding.spans === undefined || finding.spans.length === 0
    ? { ranges: [] as MarkRange[], placement: 'unquoted' as MarkPlacement }
    : section.isLive === true
      ? { ranges: [] as MarkRange[], placement: 'unsettled' as MarkPlacement }
      : placeAnchors(section.content, finding.spans)

  return {
    key: findingKey(finding, finding.stage),
    kind: 'finding',
    section: finding.section,
    label,
    origin: findingOrigin(finding),
    reason: finding.reason,
    quotes,
    ranges: placed.ranges,
    placement: placed.placement,
    rewrittenSince,
    instruction: spendInstruction(label, finding.reason, quotes),
    spendNote: section === undefined ? 'This section is not in the script' : spendCostNote(section),
    spendable: section !== undefined && canSpend
  }
}

const draftFlag = (
  flag: ReaderFlag,
  section: MarkableSection | undefined,
  canSpend: boolean
): DraftMark => {
  const placed = section === undefined
    ? { ranges: [] as MarkRange[], placement: 'stale' as MarkPlacement }
    : section.isLive === true
      ? { ranges: [] as MarkRange[], placement: 'unsettled' as MarkPlacement }
      : placeAnchors(section.content, [flag.anchor])

  const reason = flag.note ?? ''
  return {
    key: flag.id,
    kind: 'flag',
    section: flag.section,
    label: flag.label,
    origin: 'Your mark',
    reason,
    quotes: [flag.anchor.quote],
    ranges: placed.ranges,
    placement: placed.placement,
    rewrittenSince: section !== undefined && flag.revisions !== sectionRevisions(section),
    instruction: spendInstruction(
      flag.label,
      reason === '' ? 'the reader marked it' : reason,
      [flag.anchor.quote]
    ),
    spendNote: section === undefined ? 'This section is not in the script' : spendCostNote(section),
    spendable: section !== undefined && canSpend
  }
}

// Where a mark begins, for ordering. A mark with nowhere to sit sorts after
// every mark that has somewhere, so the panel reads down the page.
const firstOffset = (mark: DraftMark): number =>
  mark.ranges[0]?.start ?? Number.MAX_SAFE_INTEGER

const toneOf = (kinds: Set<MarkKind>): MarkRun['tone'] => {
  if (kinds.size === 0) return 'plain'
  if (kinds.size > 1) return 'both'
  return kinds.has('finding') ? 'finding' : 'flag'
}

// Cut one paragraph at every mark boundary that falls inside it.
//
// Runs that end up with the same marks covering them are joined back together,
// so a boundary belonging to some other paragraph's mark never shows up as a
// seam in this one.
// What a screen reader hears when it reaches a marked stretch of text. Each
// covering mark names itself and who made it, because a highlight the reader
// cannot see says nothing on its own.
const runAnnouncement = (covering: readonly SectionMark[]): string =>
  covering.length === 0
    ? ''
    : `Marked passage: ${covering.map(mark => `${mark.origin} — ${mark.label}`).join('; ')}.`

const paragraphRuns = (
  sectionId: string,
  paragraph: BodyParagraph,
  marks: readonly SectionMark[],
  focusedMarkId: string | null
): MarkRun[] => {
  const end = paragraph.start + paragraph.text.length
  const cuts = new Set<number>([paragraph.start, end])
  for (const mark of marks) {
    for (const range of mark.ranges) {
      if (range.end <= paragraph.start || range.start >= end) continue
      cuts.add(Math.max(paragraph.start, range.start))
      cuts.add(Math.min(end, range.end))
    }
  }

  const ordered = [...cuts].sort((left, right) => left - right)
  const runs: MarkRun[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i] ?? 0
    const to = ordered[i + 1] ?? 0
    if (to <= from) continue
    const covering = marks.filter(mark =>
      mark.ranges.some(range => range.start <= from && range.end >= to)
    )
    const markIds = covering.map(mark => mark.id)
    const previous = runs[runs.length - 1]
    const text = paragraph.text.slice(from - paragraph.start, to - paragraph.start)
    if (previous && previous.markIds.join(' ') === markIds.join(' ')) {
      previous.text += text
      continue
    }
    runs.push({
      key: `${sectionId}_${paragraph.key}_run_${runs.length}`,
      text,
      markIds,
      tone: toneOf(new Set(covering.map(mark => mark.kind))),
      focused: focusedMarkId !== null && markIds.includes(focusedMarkId),
      announcement: runAnnouncement(covering)
    })
  }
  return runs
}

// The whole document's marks, in one pass.
//
// One entry point rather than one call per section, because the ids have to be
// unique across the page and the panel has to list marks in reading order —
// both of which are facts about the document, not about any one section.
export function documentMarkView(input: MarkViewInput): DocumentMarkView {
  const sectionByTitle = new Map(input.sections.map(section => [section.title, section]))
  const dismissed = new Set(input.dismissed)
  const spent = new Set(input.spent)
  // The store keys already drawn, so one key is one mark on the page: the
  // render id is derived from the key, and two marks sharing an id would share
  // an element id and a focus.
  const drawn = new Set<string>()

  const draftsBySection = new Map<string, DraftMark[]>()
  const orphans: DraftMark[] = []

  const file = (draft: DraftMark): void => {
    // Every section in the document was seeded above, so a miss here means the
    // mark names a section this script does not have.
    const drafts = draftsBySection.get(draft.section)
    if (drafts) drafts.push(draft)
    else orphans.push(draft)
  }

  // Seeded before anything is filed so a section with no marks still gets an
  // entry, and so a mark naming a section that does not exist can be told apart
  // from one that simply arrived first.
  for (const section of input.sections) draftsBySection.set(section.title, [])

  for (const finding of input.findings) {
    const key = findingKey(finding, finding.stage)
    if (dismissed.has(key) || spent.has(key)) continue
    // Two findings identical in stage, section, reason and quote are one
    // finding as far as anything downstream can tell — they share a key, and
    // therefore a dismissal and a render id — so only the first is drawn.
    // Listing both would put two identical entries in the panel whose buttons
    // did the same thing to the same record.
    if (drawn.has(key)) continue
    drawn.add(key)
    file(draftFinding(finding, sectionByTitle.get(finding.section), input.canSpend))
  }
  for (const flag of input.flags) {
    if (drawn.has(flag.id)) continue
    drawn.add(flag.id)
    file(draftFlag(flag, sectionByTitle.get(flag.section), input.canSpend))
  }

  const bySection: Record<string, SectionMarkView> = {}
  const marks: SectionMark[] = []

  for (const section of input.sections) {
    const drafts = [...(draftsBySection.get(section.title) ?? [])]
      .sort((left, right) => firstOffset(left) - firstOffset(right))
    const sectionMarks: SectionMark[] = drafts.map(draft => ({
      ...draft,
      id: markRenderId(draft.key)
    }))
    const paragraphs = bodyParagraphs(section.content).map(paragraph => ({
      key: paragraph.key,
      runs: paragraphRuns(section.id, paragraph, sectionMarks, input.focusedMarkId)
    }))
    // Which drawn element carries each mark. A mark cut in two by an
    // overlapping one covers several runs, and only the first of them can hold
    // the element id the panel points at — so the panel is told which run that
    // is rather than assuming the mark and the element are one to one.
    const runs = paragraphs.flatMap(paragraph => paragraph.runs)
    for (const mark of sectionMarks) {
      const carrier = runs.find(run => run.markIds.includes(mark.id))
      if (carrier) mark.anchorRunKey = carrier.key
    }
    marks.push(...sectionMarks)
    bySection[section.title] = { paragraphs, marks: sectionMarks }
  }

  // A finding can name a section the script does not have — a critique of an
  // outline entry nobody wrote yet, or one written against a title that has
  // since been renamed. It has nowhere to be drawn, but dropping it would hide
  // a judgement the model actually made, so it is listed last with nothing to
  // spend it on.
  marks.push(...orphans.map(draft => ({ ...draft, id: markRenderId(draft.key) })))

  return { bySection, marks }
}

// The element the reading view should bring into view, given the mark the
// reader asked to be shown. Null when nothing is focused, or when the focused
// mark has no passage left to show.
export const focusedRunKey = (
  marks: readonly SectionMark[],
  focusedMarkId: string | null
): string | null => {
  if (focusedMarkId === null) return null
  return marks.find(mark => mark.id === focusedMarkId)?.anchorRunKey ?? null
}

// Why the reader's selection could not be marked, in their terms.
//
// A refusal has to teach the reader the same rule the model is held to, or the
// two halves of this feature would be marking passages by different rules: a
// mark that cannot be found again after the words around it move is worse than
// no mark, because it silently moves onto words nobody chose.
export const selectionFaultNote = (
  resolution: Extract<SpanResolution, { ok: false }>
): string => {
  switch (resolution.fault) {
    case 'short':
      return `Select at least ${SPAN_MIN_CHARS} characters — that was ${resolution.chars}. A shorter passage cannot be found again once the words around it change.`
    case 'long':
      return `That is ${resolution.chars} characters; a mark holds at most ${SPAN_QUOTE_MAX}. Beyond that the objection is to the section rather than to a passage in it.`
    case 'ambiguous':
      return `Those words appear ${resolution.matches} times in this section. Select a little more, so the mark names which one you meant.`
    case 'absent':
      return 'Those words are not in this section. A selection that crosses out of one section cannot be marked.'
    default:
      return 'Nothing was selected.'
  }
}
