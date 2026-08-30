import YAML from 'yaml'
import type {
  RawConversation,
  Generation,
  ChatMessage,
  CritiqueFinding,
  CritiqueRecord,
  CritiqueSpan,
  GenerationToolCall,
  GenerationMetrics,
  GenerationRound,
  PlannedRoundKind
} from '../types/conversation'
import {
  GROUNDING_SELECT_TOOL,
  OUTLINE_WRITE_TOOL,
  SECTION_WRITE_TOOL,
  SECTION_REVISE_TOOL,
  CRITIQUE_RECORD_TOOL,
  CRITIQUE_STAGES,
  type WritingToolName
} from './writingTools'

const TOOL_NAMES: readonly string[] = [
  GROUNDING_SELECT_TOOL,
  OUTLINE_WRITE_TOOL,
  SECTION_WRITE_TOOL,
  SECTION_REVISE_TOOL,
  CRITIQUE_RECORD_TOOL
]

const isWritingToolName = (value: unknown): value is WritingToolName =>
  typeof value === 'string' && TOOL_NAMES.includes(value)

// Reads stored tool calls back, dropping anything it does not recognise
// rather than failing. A file may have been written by a newer build naming
// a tool this one has never heard of, or by a build whose record shape has
// moved on; the prose is in `response` and is what the reader actually needs,
// so a tool call it cannot make sense of is worth less than the script it
// would otherwise take down with it. Shared with the library importer so both
// entry points drop on exactly the same terms.
export const sanitizeGenerationToolCalls = (value: unknown): GenerationToolCall[] | undefined => {
  if (!Array.isArray(value)) return undefined

  const calls: GenerationToolCall[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    if (!isWritingToolName(record.name)) continue
    if (record.status !== 'accepted' && record.status !== 'rejected' && record.status !== 'waived') {
      continue
    }
    // Fields are rebuilt in the order they are declared on GenerationToolCall
    // so that a reparsed call serializes back to byte-identical YAML — a file
    // that changed every time it was opened would churn storage for nothing.
    calls.push({
      id: record.id,
      name: record.name,
      ...(typeof record.title === 'string' && record.title.length > 0
        ? { title: record.title }
        : {}),
      status: record.status,
      ...(typeof record.wordCount === 'number' && Number.isFinite(record.wordCount)
        ? { wordCount: record.wordCount }
        : {}),
      ...(typeof record.reason === 'string' && record.reason.length > 0
        ? { reason: record.reason }
        : {})
    })
  }

  // An empty list and no list at all mean the same thing to every reader, so
  // they are stored the same way — which also keeps serialize/parse stable.
  return calls.length > 0 ? calls : undefined
}

// Reads stored run metrics back, on exactly the terms the tool calls above
// are read on: anything unrecognised is DROPPED rather than thrown, because
// metrics are evidence about a request and the script itself is in
// `response` — a malformed number is not worth losing a conversation over.
//
// The span is the admission test. A record with no startedAt/endedAt is not a
// measurement of anything, and every other field is optional, so without the
// pair there would be nothing to distinguish a metrics record from an empty
// object. Each remaining field is dropped on its own if it is the wrong shape,
// and the whole thing is rebuilt in declaration order so that a reparsed
// record serializes back to byte-identical YAML — a file that changed every
// time it was opened would churn storage for nothing.
export const sanitizeGenerationMetrics = (value: unknown): GenerationMetrics | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>

  const finiteNumber = (field: unknown): number | undefined =>
    typeof field === 'number' && Number.isFinite(field) ? field : undefined

  const startedAt = finiteNumber(record.startedAt)
  const endedAt = finiteNumber(record.endedAt)
  if (startedAt === undefined || endedAt === undefined) return undefined

  const firstTokenAt = finiteNumber(record.firstTokenAt)
  const promptTokens = finiteNumber(record.promptTokens)
  const completionTokens = finiteNumber(record.completionTokens)
  const cachedTokens = finiteNumber(record.cachedTokens)

  return {
    startedAt,
    endedAt,
    ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(typeof record.finishReason === 'string' && record.finishReason.length > 0
      ? { finishReason: record.finishReason }
      : {}),
    // Only an explicit true is an abort. Anything else — absent, false, a
    // string — reads as "nothing was recorded", which is what absent means.
    ...(record.aborted === true ? { aborted: true } : {})
  }
}

// Reads a stored critique record back, on exactly the terms the tool calls
// above are read on: drop, never throw. A critique is a judgement ABOUT the
// script, and the script itself is in `response`, so a record this build
// cannot make sense of is worth less than the conversation it would otherwise
// take down with it.
//
// The stage and the verdict are the admission test: a record naming neither
// says nothing, and a stage this build has never heard of is a judgement it
// cannot place. Each finding is admitted on its own — a malformed one is
// dropped and the rest survive, because findings are independent claims.
//
// Fields are rebuilt in the order they are declared on CritiqueRecord,
// CritiqueFinding and CritiqueSpan so that a reparsed record serializes back
// to byte-identical YAML — a file that changed every time it was opened would
// churn storage for nothing.
const sanitizeCritiqueSpans = (value: unknown): CritiqueSpan[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const spans: CritiqueSpan[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    // The quote is the whole of a span's claim; without it the context and the
    // occurrence describe nothing findable.
    if (typeof record.quote !== 'string' || record.quote.length === 0) continue
    if (typeof record.before !== 'string' || typeof record.after !== 'string') continue
    if (typeof record.occurrence !== 'number' || !Number.isInteger(record.occurrence)) continue
    if (record.occurrence < 0) continue
    spans.push({
      quote: record.quote,
      before: record.before,
      after: record.after,
      occurrence: record.occurrence
    })
  }
  return spans.length > 0 ? spans : undefined
}

export const sanitizeGenerationCritique = (value: unknown): CritiqueRecord | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>

  const stage = CRITIQUE_STAGES.find(candidate => candidate === record.stage)
  if (!stage) return undefined
  if (record.verdict !== 'pass' && record.verdict !== 'revise') return undefined

  const findings: CritiqueFinding[] = []
  for (const entry of Array.isArray(record.findings) ? record.findings : []) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const finding = entry as Record<string, unknown>
    if (typeof finding.section !== 'string' || finding.section.length === 0) continue
    if (typeof finding.reason !== 'string' || finding.reason.length === 0) continue

    const rules = Array.isArray(finding.rules)
      ? finding.rules.filter(
          (rule): rule is number => typeof rule === 'number' && Number.isInteger(rule)
        )
      : []
    const spans = sanitizeCritiqueSpans(finding.spans)
    // `revisions` is meaningless without the spans it was recorded for, so it
    // is kept exactly when they are — the pairing the record promises.
    const revisions =
      spans && typeof finding.revisions === 'number' && Number.isFinite(finding.revisions)
        ? finding.revisions
        : undefined

    findings.push({
      section: finding.section,
      ...(rules.length > 0 ? { rules } : {}),
      ...(spans ? { spans } : {}),
      ...(spans ? { revisions: revisions ?? 0 } : {}),
      reason: finding.reason
    })
  }

  // A revising verdict whose every finding was dropped is no longer a
  // judgement anything can act on, but it is still evidence that the pass ran
  // and did not approve — which is what the round gate reads. It is kept with
  // an empty list rather than discarded.
  return { stage, verdict: record.verdict, findings }
}

const ROUND_KINDS: readonly string[] = [
  'outline',
  'outline-critique',
  'section',
  'style-critique',
  'review'
]

const isPlannedRoundKind = (value: unknown): value is PlannedRoundKind =>
  typeof value === 'string' && ROUND_KINDS.includes(value)

// Reads a stored round record back, on exactly the terms the tool calls above
// are read on: drop, never throw. A file may have been written by a build that
// plans a stage this one has never heard of, and the script is in `response`
// either way — an unreadable record of WHY a generation was made is not worth
// losing the generation over. A dropped record costs one thing and one thing
// only: a planner reading that conversation back may re-run a stage whose
// record it could not read, which maxRounds bounds.
//
// Fields are rebuilt in the order they are declared on GenerationRound so that
// a reparsed record serializes back to byte-identical YAML — a file that
// changed every time it was opened would churn storage for nothing.
export const sanitizeGenerationRound = (value: unknown): GenerationRound | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>

  if (typeof record.round !== 'number' || !Number.isFinite(record.round)) return undefined
  if (!isPlannedRoundKind(record.kind)) return undefined

  return {
    round: record.round,
    kind: record.kind,
    ...(typeof record.sectionIndex === 'number' && Number.isFinite(record.sectionIndex)
      ? { sectionIndex: record.sectionIndex }
      : {})
  }
}

interface YamlBlock {
  type: 'conversation' | 'prompt' | 'response'
  timestamp?: number
  role?: 'user' | 'assistant' | 'system'
  id?: string
  scriptId?: string
  createdAt?: number
  updatedAt?: number
  cachedTokens?: number
  model?: string
  exampleIds?: string[]
  toolCalls?: unknown
  metrics?: unknown
  critique?: unknown
  round?: unknown
}

export function parseConversationFromYamlMarkdown(content: string): RawConversation | null {
  if (!content) return null
  
  const blocks = content.split(/^---$/gm).filter(Boolean)
  
  let conversation: RawConversation | null = null
  const currentMessages: ChatMessage[] = []
  const generations: Generation[] = []
  let pendingPrompt: ChatMessage | null = null
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim()
    if (!block) continue
    
    try {
      const parsed = YAML.parse(block) as YamlBlock
      
      if (parsed.type === 'conversation') {
        conversation = {
          id: parsed.id || '',
          scriptId: parsed.scriptId || '',
          generations: [],
          // `??`, never `||`: an epoch timestamp of 0 is a real timestamp,
          // and treating it as absent would re-stamp it with now — so the same
          // file would come back different every time it was opened
          createdAt: parsed.createdAt ?? Date.now(),
          updatedAt: parsed.updatedAt ?? Date.now()
        }
      } else if (parsed.type === 'prompt' && parsed.role === 'user') {
        const nextBlock = blocks[i + 1]?.trim()
        if (nextBlock && !nextBlock.startsWith('type:')) {
          pendingPrompt = {
            role: 'user',
            content: nextBlock
          }
          i++
        }
      } else if (parsed.type === 'response' && parsed.role === 'assistant') {
        const nextBlock = blocks[i + 1]?.trim()
        // The block after the header is the response body unless it is the
        // next header, in which case this generation simply has no prose
        const hasBody = Boolean(nextBlock) && !nextBlock!.startsWith('type:')
        const body = hasBody ? nextBlock! : ''
        const toolCalls = sanitizeGenerationToolCalls(parsed.toolCalls)

        // A generation earns its place if it produced prose or made a tool
        // call. Skipping a bodiless one would strand its prompt in
        // pendingPrompt and attach it to the next generation instead.
        //
        // A round record is deliberately NOT part of this test, and must never
        // become part of it. The already-deployed parser has never heard of
        // `round`, so a generation earning its place through a round alone
        // would be dropped by that parser and strand its prompt onto the next
        // generation — the file would read differently in the two builds. The
        // invariant that makes this safe: a round record only ever rides on a
        // generation that already earns its place through prose or a tool
        // call, which every round handler satisfies by always storing one
        // non-empty line even when its stage wrote nothing.
        if (body || toolCalls) {
          if (pendingPrompt) {
            currentMessages.push(pendingPrompt)
          }

          // Only a generation with prose contributes an assistant turn; an
          // empty assistant message would be a message the model never sent
          if (body) {
            const assistantMessage: ChatMessage = {
              role: 'assistant',
              content: body
            }

            currentMessages.push(assistantMessage)
          }

          generations.push({
            messages: [...currentMessages],
            response: body,
            timestamp: parsed.timestamp || Date.now(),
            cachedTokens: parsed.cachedTokens,
            exampleIds: Array.isArray(parsed.exampleIds)
              ? parsed.exampleIds.map(String)
              : undefined,
            toolCalls,
            metrics: sanitizeGenerationMetrics(parsed.metrics),
            critique: sanitizeGenerationCritique(parsed.critique),
            round: sanitizeGenerationRound(parsed.round)
          })

          pendingPrompt = null
        }

        if (hasBody) i++
      }
    } catch {
      continue
    }
  }
  
  if (conversation) {
    conversation.generations = generations
    return conversation
  }
  
  return null
}

export function serializeConversationToYamlMarkdown(conversation: RawConversation): string {
  const lines: string[] = []
  
  lines.push('---')
  lines.push(YAML.stringify({
    type: 'conversation',
    id: conversation.id,
    scriptId: conversation.scriptId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  }).trim())
  lines.push('---')
  lines.push('')
  
  for (const generation of conversation.generations) {
    // The LAST user message, not the first: every generation after the outline
    // is sent the whole flattened conversation (buildConversationHistory), so
    // its `messages` open with the outline prompt and end with the request this
    // generation actually made. Writing the first would file the outline prompt
    // as every generation's prompt, and since parsing rebuilds `messages` by
    // accumulating the blocks it reads, one save-and-reload would make that the
    // stored truth — leaving the activity thread, which matches on the request
    // wording, with nothing to match. The same reasoning picks the last
    // assistant message: on a reparsed generation the earlier ones belong to
    // earlier generations.
    const userMessage = [...generation.messages].reverse().find(m => m.role === 'user')
    const assistantMessage = [...generation.messages].reverse().find(m => m.role === 'assistant')
    // The generation's own response is authoritative; some generations (e.g.
    // the outline) carry no assistant message in their request messages
    const responseContent = generation.response || assistantMessage?.content || ''
    const toolCalls = generation.toolCalls
    // Written through the same sanitizer that reads it back, so a serialize →
    // parse → serialize round trip is byte-stable whatever a caller put on the
    // generation
    const metrics = sanitizeGenerationMetrics(generation.metrics)
    // Same round trip, same reason
    const critique = sanitizeGenerationCritique(generation.critique)
    const round = sanitizeGenerationRound(generation.round)
    
    if (userMessage) {
      lines.push('---')
      lines.push(YAML.stringify({
        type: 'prompt',
        timestamp: generation.timestamp,
        role: 'user'
      }).trim())
      lines.push('---')
      lines.push(userMessage.content)
      lines.push('')
    }
    
    // A generation that only made tool calls has no prose to write, but its
    // calls still have to be written — and without a response block its
    // prompt would be reparsed onto the following generation
    if (responseContent || (toolCalls && toolCalls.length > 0)) {
      lines.push('---')
      lines.push(YAML.stringify({
        type: 'response',
        timestamp: generation.timestamp,
        role: 'assistant',
        cachedTokens: generation.cachedTokens,
        ...(generation.exampleIds && generation.exampleIds.length > 0
          ? { exampleIds: generation.exampleIds }
          : {}),
        // Optional, like exampleIds: absent when there are none, so files
        // written here still parse under a build that predates the field
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        // Also optional, and deliberately NOT part of the admission test
        // above: metrics describe a request, so they are worth keeping when a
        // generation is kept, and never a reason on their own to keep a
        // generation that wrote nothing.
        ...(metrics ? { metrics } : {}),
        // Optional on the same terms, and also not part of the admission test:
        // a critique is a judgement about the script, so it is worth keeping
        // when its generation is kept and is never on its own a reason to keep
        // one. Every critique round already stores a non-empty response line,
        // so no record is stranded by that.
        ...(critique ? { critique } : {}),
        // Optional and, like metrics, deliberately not part of the admission
        // test above: a round says why a generation was made, never that one
        // should be kept
        ...(round ? { round } : {})
      }).trim())
      lines.push('---')
      lines.push(responseContent)
      lines.push('')
    }
  }
  
  return lines.join('\n')
}

export function migrateJsonToYamlMarkdown(jsonData: RawConversation[]): Map<string, string> {
  const conversationMap = new Map<string, string>()
  
  if (Array.isArray(jsonData)) {
    for (const conv of jsonData) {
      if (conv.scriptId) {
        const yamlMarkdown = serializeConversationToYamlMarkdown(conv)
        conversationMap.set(`conversation_${conv.scriptId}`, yamlMarkdown)
      }
    }
  }
  
  return conversationMap
}
