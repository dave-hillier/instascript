import type { GenerationRound, PlannedRoundKind } from '../types/conversation'
import type { ProjectedDocument } from './scriptProjection'

// What a run does next, decided from the conversation alone.
//
// One pure function decides; one loop executes; the durable conversation is
// the memory. There is no run state to keep in step with the document, which
// is what makes a resume the same code path as a first attempt: an interrupted
// run and a fresh one ask the same question of the same projection and get the
// same answer.
//
// Nothing here is async, touches React or reads storage, so the whole
// sequencing decision of a generation run is testable in a node process.

export type { PlannedRoundKind }

export interface PlannedRound {
  round: number
  kind: PlannedRoundKind
  // Present only on a 'section' round: the index into the plan's sections
  sectionIndex?: number
}

// The optional stages a run performs, resolved once at run start.
//
// Deliberately NOT here: whether the run writes by tool call or as prose. That
// is a run-level fact about how the words are asked for, and what to write
// next has nothing to do with it — which is why a conversation begun in prose
// and continued with tools plans identically.
export interface GenerationPipeline {
  readonly outlineCritique: boolean
  readonly styleCritique: boolean
  readonly review: boolean
  readonly maxRounds: number
}

// A stall detector, not a policy. The real backstop on a run that keeps
// failing is SECTION_REJECTION_BUDGET, which bounds the rewrites; this bounds
// the number of times the planner may be asked at all, so a stage that somehow
// never records its round ends the run loudly instead of spinning against a
// paid API.
export const MAX_ROUNDS = 64

// One checkbox, two stages. The "Review pass" setting has always switched on
// both the outline critique and the style critique, and its help text already
// admits it is two things; splitting it into two fields here rather than two
// settings keeps the planner honest about what it gates without migrating
// every saved boolean in every existing installation.
//
// `review` — the whole-script review — is false: it stays the button it has
// always been (see the round-stamping in reviewScript). Making it automatic
// would be a real per-run latency and token cost dressed up as a refactor.
export const resolvePipeline = (settings: { reviewPass: boolean }): GenerationPipeline => ({
  outlineCritique: settings.reviewPass,
  styleCritique: settings.reviewPass,
  review: false,
  maxRounds: MAX_ROUNDS
})

const ran = (rounds: readonly GenerationRound[], kind: PlannedRoundKind): boolean =>
  rounds.some(round => round.kind === kind)

// A conversation written before round records existed carries none, and its
// optional passes may perfectly well have run — nothing recorded them either
// way. Treating it as never-critiqued would re-run a style critique over a
// finished script every time a reader opened it and pressed resume, forever.
// So a legacy conversation's RECORD gates are considered satisfied.
//
// Its ARTIFACT gates still apply, which is what lets an old half-finished
// script resume at the right section rather than starting over.
export const isLegacyConversation = (document: ProjectedDocument): boolean =>
  document.rounds.length === 0 && document.sections.length > 0

export function planNextRound(
  document: ProjectedDocument,
  pipeline: GenerationPipeline
): PlannedRound | null {
  // Numbered from the last round RECORDED, never from rounds.length: a round
  // whose generations were discarded, or whose record the parser could not
  // read, still used its number. Counting records instead would re-issue a
  // number already spent, leaving this function proposing the same round
  // forever with maxRounds never reached.
  const round = (document.rounds[document.rounds.length - 1]?.round ?? 0) + 1
  if (round > pipeline.maxRounds) return null

  const legacy = isLegacyConversation(document)

  // Artifact gate: no plan, no run. A refused outline call leaves no plan
  // folded, so this re-plans the outline with no retry protocol of its own.
  if (!document.outline) return { round, kind: 'outline' }

  // The `sections.length === 0` clause is an ORDERING guard, not a gate. The
  // critique's product is a possibly-revised PLAN, and revising a plan under
  // sections already written orphans them — no path in this app reconciles
  // that. A run resumed into a half-written script therefore skips the
  // critique rather than restructuring the script underneath itself.
  if (
    pipeline.outlineCritique &&
    !legacy &&
    document.sections.length === 0 &&
    !ran(document.rounds, 'outline-critique')
  ) {
    return { round, kind: 'outline-critique' }
  }

  // Artifact gate, matched on TITLE rather than index: an outline critique can
  // rewrite the plan and reorder it under the sections already written, and
  // every other fold in this app identifies a section by its title.
  //
  // This replaces `startIndex = Math.max(0, firstMissing - 1)`, which redid the
  // last written section unconditionally — including on a resume of a script
  // that had finished cleanly. truncationSuspect redoes it only when the body
  // might actually be a fragment.
  const written = new Map(document.sections.map(section => [section.title, section]))
  const next = document.outline.sections.findIndex(section => {
    const body = written.get(section.title)
    return body === undefined || body.truncationSuspect === true
  })
  if (next !== -1) return { round, kind: 'section', sectionIndex: next }

  // Record gates. Both of these stages store an approving verdict as ordinary
  // prose, which is indistinguishable in the log from a stage that never ran —
  // the record is the only evidence either way.
  if (pipeline.styleCritique && !legacy && !ran(document.rounds, 'style-critique')) {
    return { round, kind: 'style-critique' }
  }
  if (pipeline.review && !legacy && !ran(document.rounds, 'review')) {
    return { round, kind: 'review' }
  }

  return null
}
