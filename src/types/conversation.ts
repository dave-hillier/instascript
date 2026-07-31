

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

export interface Generation {
  messages: ChatMessage[] // Complete messages array sent to OpenAI
  response: string // Assistant response received
  timestamp: number
  cachedTokens?: number // From OpenAI response for monitoring cache hits
  exampleIds?: string[] // Ids of the corpus examples that informed this generation
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
