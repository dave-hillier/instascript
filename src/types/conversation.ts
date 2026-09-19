// The tool-name union lives with the tool declarations so the stored record
// and the schemas sent to the model can never name different tools. This is a
// type-only import, so it adds nothing to the runtime graph.
import type { CritiqueStage, CritiqueVerdictName, WritingToolName } from '../services/writingTools'

export interface GenerationRequest {
  prompt: string
  conversationId?: string
  // Requested spoken length in minutes; the generation's length plan is
  // derived from it. Absent falls back to the default target.
  targetMinutes?: number
  // When true, discard any existing outline and sections and start the
  // generation from scratch instead of resuming (story 1.8)
  fresh?: boolean
}

export interface RegenerationRequest {
  prompt: string
  conversationId: string
  sectionTitle: string
  // The run's requested length. A rewrite must be judged against the length
  // the script was generated for, not the default.
  targetMinutes?: number
  // The original brief. A rewrite's own prompt is a filled-in instruction
  // template, so it is useless for ranking the example corpus.
  brief?: string
}

export interface SectionRegenerationRequest {
  conversationId: string
  sectionTitle: string
  instruction?: string
  targetMinutes?: number
  brief?: string
}

// A whole-script refinement instruction from the user (story 1.6)
export interface ScriptRefinementRequest {
  conversationId: string
  instruction: string
  targetMinutes?: number
  brief?: string
}

// A manual, in-place edit of one section's text (story 2.3)
export interface SectionEditRequest {
  conversationId: string
  sectionTitle: string
  content: string
}

// The fully built refinement prompt handed to the orchestrator
export interface RefinementRequest {
  prompt: string
  conversationId: string
  targetMinutes?: number
  brief?: string
}

export interface GenerationProgress {
  conversationId: string
  sectionTitle?: string
  content: string
  isComplete: boolean
  error?: string
}

// New simplified types for raw response storage
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// One writing tool call the model made during a generation, kept as the
// durable record of what it did and how it was judged.
//
// It deliberately carries STRUCTURE, NOT PROSE. The section body lives in
// `Generation.response`, which stays the single rendered projection of the
// run and the only place the text is stored; storing the body here as well
// would roughly double the size of every conversation file, and conversations
// persist to a ~5MB localStorage budget wherever OPFS is unavailable. So the
// call records who wrote what and whether it was kept, and `response` records
// what was written — never both.
//
// Everything on it must be plain structured-cloneable data (no class
// instances, no functions): `duplicateRawConversation` copies generations
// with `structuredClone`.
export interface GenerationToolCall {
  // The provider's tool_call_id, so a call can be matched to the tool result
  // that answered it
  id: string
  name: WritingToolName
  // The section (or outline) title the call names, where the call has one
  title?: string
  // Whether the body was kept, sent back to be rewritten, or kept despite
  // failing the length window because the attempt budget ran out
  status: GenerationToolCallStatus
  // The measured body length, in words, that the status was decided on
  wordCount?: number
  // Why: the rejection's complaint, the waiver's justification, or for a
  // section_revise the reason the section was rewritten
  reason?: string
}

// `waived` is the length-waiver outcome: the section never landed inside the
// word window within its attempt budget, so the closest attempt was accepted
// anyway. It is a distinct status rather than an `accepted` with a note so
// that it stays visible instead of quietly reading as a clean acceptance.
export type GenerationToolCallStatus = 'accepted' | 'rejected' | 'waived'

// The stages a run can be asked to perform, in the vocabulary the planner and
// the round record share. It is declared HERE rather than beside the planner
// so that the durable type can name it without the types module reaching down
// into a service: everything under types/ is read by the parser, the importer
// and the reducer, and none of them should have to import a planner to read a
// stored field.
//
// Deliberately short. There is no 'grounding' and no 'briefing': grounding is
// local retrieval performed once as a run precondition, and briefing happens
// before the conversation exists. A kind this build does not recognise is
// dropped on the way in, so a later build can add one without stranding a file
// written by this one.
export type PlannedRoundKind =
  | 'outline'
  | 'outline-critique'
  | 'section'
  | 'style-critique'
  | 'review'

// One planned round this generation is the product of. Like GenerationToolCall
// it carries STRUCTURE, never prose, and is plain structured-cloneable data:
// duplicateRawConversation copies generations with structuredClone.
//
// It exists for the stages that legitimately produce no artifact of their own.
// An outline critique that approves and one that never ran leave the same
// conversation behind, so without a record of the round a planner reading that
// conversation back would ask for the critique again, and again, forever.
export interface GenerationRound {
  // Monotonic within the conversation. Numbering advances from the last
  // record, not from how many records there are, so a round whose generations
  // were discarded still consumed its number.
  round: number
  kind: PlannedRoundKind
  // Present only on a section round: the index into the outline the round was
  // planned against. Recorded for the activity log and for reading a plan
  // back; the section gate itself matches on TITLE, because an outline
  // critique can rewrite the plan and reorder it under the sections already
  // written.
  sectionIndex?: number
}

// What one provider request cost and how it behaved, recorded on the
// generation the request produced. The frames carrying this — `firstToken`,
// `usage`, `finished` — have been streaming past unread since the frame
// protocol landed, while the cost summary estimated tokens from a character
// heuristic; this is where the real numbers come to rest so they survive a
// reload, an export and a duplicate.
//
// Every field but the span is OPTIONAL, because every one of them is
// something a provider may simply not send: a provider without
// `include_usage` reports no tokens, a stream that dies reports no finish
// reason, and a generation written before this existed has no metrics at all.
// A reader must treat all of it as evidence that may be missing rather than
// as a record it can require.
//
// Deliberately NOT here: the model and provider names (they live on the
// Script, and a per-generation copy would be a second truth to keep in step);
// duration and latency-to-first-token (arithmetic on the fields below);
// cost (arithmetic on the tokens and the price table, which changes after the
// fact); and reasoning tokens (nothing in the stream carries them today, so
// the field would be permanently unpopulated — exactly the defect
// `cachedTokens` had).
//
// Plain structured-cloneable data, like GenerationToolCall above and for the
// same reason: `duplicateRawConversation` copies generations with
// `structuredClone`.
export interface GenerationMetrics {
  // When the request went out and when its stream ended, in epoch
  // milliseconds. The pair is the one thing always present — it is measured
  // here rather than reported by the provider.
  startedAt: number
  endedAt: number
  // When the first delta of either kind arrived, as the stream reported it
  firstTokenAt?: number
  promptTokens?: number
  completionTokens?: number
  // The cached share of promptTokens, where the provider breaks it out
  cachedTokens?: number
  // The provider's own finish_reason ('stop', 'tool_calls', 'length', ...)
  finishReason?: string
  // Set only when the turn ended before the model finished — the user
  // stopping the run, or a stream that failed. Absent means it ran to an end,
  // not that it succeeded: `finishReason` is what says how it ended.
  aborted?: boolean
}

// One passage a finding quoted, anchored the way a reader's own flag is.
//
// The quote is the BODY's own slice, never the string the model typed: it is
// measured against the section once, at the moment the critique is accepted,
// and everything downstream re-finds it rather than re-deciding it. A quote
// that could not be pinned never enters the record at all — the call carrying
// it was refused and asked again.
//
// Plain structured-cloneable data, like GenerationToolCall:
// duplicateRawConversation copies generations with structuredClone.
export interface CritiqueSpan {
  quote: string
  // Up to SPAN_CONTEXT_CHARS of body immediately before and after the quote,
  // so the passage can be re-found after the body around it has moved
  before: string
  after: string
  // Which occurrence of the quote in that body this was, counting from zero
  occurrence: number
}

// One fault a critique named, against one section.
export interface CritiqueFinding {
  // Exact section title the finding is against
  section: string
  // The numbered style rules the section breaks, where the pass cites any.
  // Every number here named a rule at the moment it was accepted.
  rules?: number[]
  // Present only when the finding quoted a passage; a prose critique, and a
  // finding about a section that is not written yet, carry none.
  spans?: CritiqueSpan[]
  // The section's replacement count when those spans were anchored, present
  // exactly when `spans` is. Comparing it against the section's count now is
  // what tells a passage the writer repaired from a passage that was never
  // there.
  revisions?: number
  // Why the section is at fault, in one line
  reason: string
}

// One recorded critique: what a judging pass decided, and why.
//
// It is stored on the generation the pass produced because it BELONGS TO THE
// RUN — it is a judgement the model made, in the conversation, and it travels
// with the conversation through export, import and duplication. A reader's own
// flags are a different thing and are deliberately not stored here.
//
// An approving critique is stored too. Without it, a script that was judged
// and approved and one that was never judged leave the same conversation
// behind, and the round gate reading that conversation would ask for the same
// pass again forever.
export interface CritiqueRecord {
  stage: CritiqueStage
  verdict: CritiqueVerdictName
  // Empty for a passing verdict
  findings: CritiqueFinding[]
}

export interface Generation {
  messages: ChatMessage[] // Complete messages array sent to OpenAI
  response: string // Assistant response received
  timestamp: number
  // The cached share of the prompt the provider billed. It predates
  // `metrics` and is what conversations written before them carry, so it is
  // kept and still written; on a generation written since, it is the same
  // number as `metrics.cachedTokens` because both are set from one reading.
  cachedTokens?: number
  exampleIds?: string[] // Ids of the corpus examples that informed this generation
  // The writing tool calls this generation is made of, when it was written by
  // tool call rather than as prose. Absent on every generation stored before
  // the tools existed, and on any generation that made no call.
  toolCalls?: GenerationToolCall[]
  // What the request behind this generation cost and how it ended. Absent on
  // every generation stored before metrics existed, and on any generation
  // whose provider reported nothing.
  metrics?: GenerationMetrics
  // The critique this generation recorded, when it was a judging pass that
  // recorded one. Absent on every generation that wrote script rather than
  // judging it, on a pass whose critique was never accepted, and on every
  // generation stored before critiques were recorded.
  critique?: CritiqueRecord
  // The planned round this generation was produced for, when it was produced
  // by a planned run at all. Absent on a manual section edit, on every
  // generation stored before rounds existed, and on the reader-initiated
  // commands that are not rounds.
  round?: GenerationRound
}

export interface RawConversation {
  id: string
  scriptId: string
  generations: Generation[] // All generations with complete prompt context
  createdAt: number
  updatedAt: number
}

export interface ParsedDocumentHeader {
  title?: string
  detected: boolean
}

export interface ParsedSection {
  title: string
  content: string
  wordCount: number
  startLine: number
  endLine: number
}

export interface ConversationDocument {
  header: ParsedDocumentHeader
  sections: ParsedSection[]
  fullContent: string
  totalWordCount: number
}

// State machine for section-by-section generation
export type GenerationPhase =
  | 'idle'
  | 'generating_outline'
  | 'generating_section'
  | 'reviewing'
  | 'complete'
  | 'error'

// One section a review pass acted on. The two passes now mean different things
// by it, and the name is kept only because the page and the exporter read it:
//
//  - the whole-script review (story 8.14) still REWRITES, so an entry is a
//    section it rewrote, and `reason` names why in a word ("cohesion",
//    "length");
//  - the style pass (story 8.5) no longer rewrites anything. An entry there is
//    a section it MARKED — a finding it recorded, citing the numbered style
//    rules the section breaks — and the script is exactly as the reader left
//    it. Acting on the finding is the reader's decision, which is the whole
//    point of the pass quoting the passage rather than replacing it.
export interface ReviewRevision {
  sectionTitle: string
  ruleNumbers?: number[]
  reason?: string
}

// The outcome of a review pass, shown on the script page until dismissed
export interface ReviewReport {
  conversationId: string
  // What the pass did, on the terms above: sections rewritten by the
  // whole-script review, sections marked by the style pass
  revised: ReviewRevision[]
  // Prebuilt one-line outcome; the style pass leaves it unset and the page
  // formats its rule-based revisions instead
  summary?: string
  // The section titles the report was written against. A summary names sections
  // and states a length, so it stops being true the moment the script gains,
  // loses or renames one — the page checks this before showing it.
  structure?: string[]
}

export interface OutlineSection {
  title: string
  description: string
}

export interface ScriptOutline {
  title: string
  sections: OutlineSection[]
}

export interface GenerationMachineState {
  phase: GenerationPhase
  conversationId: string
  outline: ScriptOutline | null
  currentSectionIndex: number
  totalSections: number
  sectionWordCounts: number[] // word count per generated section
  error?: string
}
