// The tool-name union lives with the tool declarations so the stored record
// and the schemas sent to the model can never name different tools. This is a
// type-only import, so it adds nothing to the runtime graph.
import type { WritingToolName } from '../services/writingTools'

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

export interface Generation {
  messages: ChatMessage[] // Complete messages array sent to OpenAI
  response: string // Assistant response received
  timestamp: number
  cachedTokens?: number // From OpenAI response for monitoring cache hits
  exampleIds?: string[] // Ids of the corpus examples that informed this generation
  // The writing tool calls this generation is made of, when it was written by
  // tool call rather than as prose. Absent on every generation stored before
  // the tools existed, and on any generation that made no call.
  toolCalls?: GenerationToolCall[]
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

// One section rewritten by a review pass: the style pass (story 8.5) cites
// the numbered style rules it violated, the whole-script review (story 8.14)
// names why in a word ("cohesion", "length")
export interface ReviewRevision {
  sectionTitle: string
  ruleNumbers?: number[]
  reason?: string
}

// The outcome of a review pass, shown on the script page until dismissed
export interface ReviewReport {
  conversationId: string
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
