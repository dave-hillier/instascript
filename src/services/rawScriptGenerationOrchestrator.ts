import type { CritiqueRecord, RawConversation, Generation, GenerationRequest, GenerationRound, GenerationToolCall, RegenerationRequest, RefinementRequest, ChatMessage, GenerationMetrics, ReviewRevision, ScriptOutline } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversationAction } from '../reducers/rawConversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt, getOutlineGenerationPrompt, getSectionGenerationPrompt, buildStyleCritiquePrompt, buildOutlineCritiquePrompt, buildScriptReviewPrompt, buildConversationHistory, buildGenerationSystemPrompt, withGenerationSystemPrompt, withStructureBlock } from './prompts'
import { buildScriptFs } from './scriptFs'
import { getRecommendedExampleCount, estimateSectionContextTokens } from '../utils/contextWindow'
import { countWords, formatScriptLength } from '../utils/scriptMetrics'
import { parseOutline, ensureSectionHeading, consolidateSections, getLatestOutline, parseMarkdownSections } from './conversationDocument'
import {
  shouldRetrySection,
  pickBetterSectionText,
  buildRetryNote,
  buildSectionRejection,
  buildSectionWaiver,
  sectionDistanceFromTarget,
  MAX_SECTION_ATTEMPTS,
  MAX_TOOL_HANDSHAKES,
  SECTION_REJECTION_BUDGET
} from './sectionQuality'
import {
  acceptCritique,
  findingsFromVerdicts,
  parseCritiqueResponse,
  parseCritiqueToolCall,
  renderCritique,
  reviewRevisionsFromFindings,
  STYLE_REVIEW_SECTION_TITLE
} from './critiquePass'
import type { CritiqueSectionBody } from './critiquePass'
import { parseOutlineCritiqueResponse, OUTLINE_CRITIQUE_SECTION_TITLE } from './outlineCritique'
import { buildLengthPlan } from './scriptLength'
import type { LengthPlan } from './scriptLength'
import { assessScriptLength, formatLengthBrief, parseScriptReviewResponse, findingsFromReviewVerdicts, formatScriptReviewSummary, SCRIPT_REVIEW_SECTION_TITLE } from './scriptReview'
import { recordExampleSelections } from './exampleCorpus'
import { isTextFrame, isThinkingFrame, isToolCallFrame } from './providerFrame'
import type { ProviderFrame } from './providerFrame'
import { scanPartialJsonObject } from './partialJson'
import { WRITING_TOOLS, GROUNDING_SELECT_TOOL, OUTLINE_WRITE_TOOL, SECTION_WRITE_TOOL, CRITIQUE_RECORD_TOOL } from './writingTools'
// The one rule for "this generation contributed nothing to the script", shared
// with the projection, the replayed history and the activity thread: four
// readers have to agree on it, so there is one copy of it
import { projectConversation, sectionRevisions } from './scriptProjection'
import type { ProjectedDocument } from './scriptProjection'
import { planNextRound, resolvePipeline } from './roundPlan'
import type { PlannedRound } from './roundPlan'
import type { WritingToolName, CritiqueStage } from './writingTools'
import type { ProviderCallOptions, ProviderTurn } from './scriptGenerationService'
import { planGeneration } from './serviceFactory'
import {
  buildToolGenerationSystemPrompt,
  getToolSystemPrompt,
  getToolOutlineGenerationPrompt,
  getToolSectionGenerationPrompt
} from './prompts'

export interface RawScriptServices {
  scriptService: {
    generateScript(
      request: GenerationRequest,
      messages?: ChatMessage[],
      examples?: ExampleScript[],
      abortSignal?: AbortSignal,
      options?: ProviderCallOptions
    ): AsyncIterable<ProviderFrame>
    regenerateSection(
      request: RegenerationRequest,
      messages: ChatMessage[],
      abortSignal?: AbortSignal,
      options?: ProviderCallOptions
    ): AsyncIterable<ProviderFrame>
  }
  exampleService: {
    searchExamples(prompt: string, count: number): Promise<ExampleScript[]>
  }
}

export interface RawGenerationCallbacks {
  dispatch: (action: RawConversationAction) => void
  appDispatch: (action: { type: 'UPDATE_SCRIPT'; scriptId: string; updates: Partial<Script> }) => void
  saveConversation: (conversation: RawConversation) => void
  getConversation: (conversationId: string) => RawConversation | undefined
  // The script a conversation belongs to, when the caller can supply it. It is
  // read for one thing: the model pinned on the script, which decides once at
  // run start whether the run is written by tool call or as prose. A caller
  // that cannot supply it leaves the decision to the current model setting.
  getScript?: (scriptId: string) => Pick<Script, 'model'> | undefined
}

export interface RawGenerationOptions {
  // When true, a full generation ends with a style-review pass (story 8.5)
  reviewPassEnabled?: boolean
}

interface ReviewPassResult {
  // True when the critique request completed, so the outcome can be reported
  ran: boolean
  // The sections the pass MARKED. It no longer rewrites any of them — the
  // report says what was found, and the reader decides what to act on.
  marked: ReviewRevision[]
  // The critique exactly as it was accepted, which is what belongs on the
  // conversation. See runReviewPass for why it does not get there yet.
  critique?: CritiqueRecord
}

// The corpus a run is grounded in, tracked for the whole run rather than per
// request: grounding_select is a once-per-run call (D4), so the second one has
// to be recognisable as a second one however many requests later it arrives.
interface RunGrounding {
  done: boolean
  examples: ExampleScript[]
}

// One tool call as it arrives, reassembled across the fragments the provider
// sends it in. `arguments` is a JSON document under construction, so it is only
// ever read through the tolerant partial scanner until the call finishes.
interface StreamedToolCall {
  index: number
  id: string
  name?: string
  arguments: string
}

// Everything one provider response carried, whichever way it answered
interface StreamedResponse {
  text: string
  // What the model reasoned before answering, when the provider reports it.
  // Never part of the script: it exists so a caller can show that a reasoning
  // model is working rather than stalled, and no path folds it into a section.
  thinking: string
  calls: StreamedToolCall[]
  finishReason: string | null
  // D6: a call may only be ACCEPTED after a clean finish. An abort landing
  // exactly at the end of a call's arguments leaves them parseable, and a
  // `length` finish means the provider cut the model off mid-body — in both
  // cases the JSON can look complete while the section is not.
  finishedCleanly: boolean
}

// One turn's metrics while its stream is still running. It is the mutable
// counterpart of GenerationMetrics: `endedAt` is not here because it is not
// known until the turn is closed, and nothing else is required because the
// frames that carry it may never arrive.
interface TurnMetricsDraft {
  startedAt: number
  firstTokenAt?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  finishReason?: string
}

const toolField = (call: StreamedToolCall, field: string): string =>
  scanPartialJsonObject(call.arguments).fields.get(field) ?? ''

// The one call that writes THIS section. section_revise is deliberately not
// accepted here: it replaces a section that has already been written, and
// treating it as this section's section_write would file a replacement of
// something else as the section the run is waiting for. It reaches the
// wrong-tool handler instead, which names the call this step needs.
const sectionCallOf = (response: StreamedResponse): StreamedToolCall | undefined =>
  response.calls.find(call => call.name === SECTION_WRITE_TOOL)

// The first call the model made that named a tool at all, for the turns where
// no writing call arrived. A call with no name never got as far as one.
const namedCallOf = (response: StreamedResponse): StreamedToolCall | undefined =>
  response.calls.find(call => !!call.name)

// How a non-writing call was answered: the tool result the model is sent back,
// the status the call is recorded under, and the non-empty durable line that
// stands as the generation's response.
//
// The response line is not markdown, because this generation wrote no prose —
// but it must not be EMPTY: a generation stored with an empty response is
// dropped, prompt and all, by the deployed parser (D1). So the turn is
// recorded as what it was, in one line that no reader can mistake for a
// section body.
interface ToolAnswer {
  content: string
  status: 'accepted' | 'rejected'
  record: string
}

// What the run already retrieved, handed back as the result of the model's
// grounding_select call. Ids and titles only: the selection is structure, and
// the exemplars themselves are already in the system prompt this request
// carries, so restating their prose here would bloat every retry for nothing
// (D3).
const answerGroundingSelect = (
  grounding: RunGrounding,
  expectedTool: string
): ToolAnswer => {
  if (grounding.done) {
    return {
      content:
        `REFUSED: grounding for this script is already done, and ${GROUNDING_SELECT_TOOL} is ` +
        `called once per script. Call ${expectedTool} next.`,
      status: 'rejected',
      record: `Refused a second ${GROUNDING_SELECT_TOOL} call; this script was already grounded.`
    }
  }

  const selected = grounding.examples.map((example, index) => ({
    id: String(example.metadata?.id ?? example.metadata?.filename ?? `example-${index + 1}`),
    title: String(example.metadata?.title ?? example.metadata?.filename ?? '')
  }))

  return {
    content:
      JSON.stringify({ selected }) +
      `\nThese are the examples this script is written against; they are already in the ` +
      `instructions you were given. Call ${expectedTool} next.`,
    // The MODEL's call was answered — `content` is the selection it asked for.
    // The stored status is about the SCRIPT, and this turn wrote none of it: a
    // handshake recorded as accepted is replayed by buildConversationHistory
    // as an assistant turn together with request messages identical to the
    // outline request that follows, so the outline prompt would be sent twice.
    // `rejected` is the shape every reader already folds out, so the handshake
    // is recorded in one shape rather than taught to four readers.
    status: 'rejected',
    record: selected.length > 0
      ? `Grounded in ${selected.length} corpus examples: ${selected.map(entry => entry.id).join(', ')}.`
      : 'Grounded with no corpus examples: none were retrieved for this script.'
  }
}

// A call arrived, but not the one this turn needs. It is answered as a refused
// call and asked again WITH THE TOOLS STILL ATTACHED, never dropped into the
// tool-less prose retry: a model that is calling tools has not failed to use
// them, it has called the wrong one, and taking the tools away would answer a
// mis-step by removing the only way it can succeed.
const answerWrongTool = (called: string, expectedTool: string, subject: string): ToolAnswer => ({
  content:
    `REFUSED: ${called} is not the call this step needs. ${subject} Call ${expectedTool} instead.`,
  status: 'rejected',
  record: `Refused a ${called} call; ${expectedTool} is the call this step needs.`
})

// The call named a different section from the one being written. Filing its
// body under the requested title would store one section's prose as another's,
// so the call is refused with the title the run is actually waiting for.
const answerWrongSection = (called: string, named: string, expected: string): ToolAnswer => ({
  content:
    `REFUSED: that call named the section "${named}", but the section being written is ` +
    `"${expected}". The section was not written. Call ${SECTION_WRITE_TOOL} again with ` +
    `title set to "${expected}".`,
  status: 'rejected',
  record: `Refused a ${called} call naming "${named}"; the section being written is "${expected}".`
})

// The outline a completed outline_write call describes, rendered as the same
// markdown the prose path stores (D1). Everything downstream — parseOutline,
// getLatestOutline, resume, the outline critique, the already-deployed parser
// that reads conversations exported from this build — reads that markdown, so
// the tool call is a different way of writing it, not a different thing to
// store. Returns null for arguments that never became a usable plan.
export function renderOutlineFromToolCall(argumentsJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return null
  }

  const outline = parsed as { title?: unknown; sections?: unknown }
  const title = typeof outline.title === 'string' ? outline.title.trim() : ''
  const sections = Array.isArray(outline.sections) ? outline.sections : []
  if (!title || sections.length === 0) return null

  const rendered = sections
    .map(entry => entry as { title?: unknown; description?: unknown })
    .filter(entry => typeof entry.title === 'string' && entry.title.trim())
    .map(entry => `## ${String(entry.title).trim()}\n${String(entry.description ?? '').trim()}`)

  if (rendered.length === 0) return null
  return `# ${title}\n${rendered.join('\n')}`
}

// Everything one round of a run needs that the conversation cannot tell it.
//
// Deliberately NOT here: the plan, the script so far, or which section is
// next. Those are folded out of the conversation immediately before each
// round, which is what makes a resumed run and a first attempt the same code
// path — there is no run state that could disagree with the document.
interface RoundContext {
  conversationId: string
  // The conversation as it stood when the run claimed it. Its generations are
  // the run's starting point; everything written since is in the run log.
  conversation: RawConversation
  request: GenerationRequest
  plan: LengthPlan
  writesByTool: boolean
  systemPrompt: string
  storedSystemPrompt: string
  examples: ExampleScript[]
  exampleIds: string[]
  grounding: RunGrounding
  rejectionBudget: { remaining: number }
  abortSignal?: AbortSignal
}

// The word counts the progress display reads, in the order the plan names its
// sections rather than the order they happened to be written — which is the
// order the reader sees them in.
const plannedSectionWordCounts = (document: ProjectedDocument): number[] => {
  if (!document.outline) return []
  const written = new Map(document.sections.map(section => [section.title, section.wordCount]))
  return document.outline.sections
    .map(section => written.get(section.title))
    .filter((count): count is number => count !== undefined)
}

// What a turn is closed with when the request came back carrying nothing at
// all — no prose, no tool call. It is deliberately a plain sentence rather
// than a REJECTED line: nothing was refused here, the model simply answered
// with nothing, and the generation exists to say that a request was made.
// How much streamed material earns one progress notification.
//
// Every notification re-reads the whole partially-arrived arguments buffer to
// recover the body inside it (toolField below), which is linear in what has
// arrived so far — so notifying on each of the hundreds of fragments a
// provider cuts a long body into is quadratic in that body's length, and one
// section at the top of the word window spends seconds scanning to render
// frames arriving far faster than anyone reads. Two hundred characters is
// about thirty words: finer than prose is read, and a thirtieth of the work.
// The tail is always notified, so what a reader last saw is the whole body.
const PROGRESS_STEP_CHARS = 200

// Reasoning is stepped far more finely than prose. Prose is read as it lands,
// so re-rendering it every 200 characters is plenty; reasoning is shown as a
// single truncated line whose only job is to look alive, and at the prose step
// it sits on its first few words for seconds at a time and reads as frozen —
// which is the exact impression it exists to dispel.
const THINKING_STEP_CHARS = 40

const EMPTY_TURN_RECORD = 'The request finished without writing anything.'

// The bodies a pass that judges an UNWRITTEN plan has to measure quotes
// against: none. acceptCritique takes the map rather than defaulting it, so a
// pass with nothing written yet says so explicitly instead of leaving the
// argument off and looking like a wiring mistake.
const NO_WRITTEN_BODIES: ReadonlyMap<string, CritiqueSectionBody> = new Map()

// How often a stream is allowed to write the conversation to storage while it
// is still arriving, so a reader who reloads mid-run keeps most of what had
// been written without every text frame costing a serialize-and-store.
//
// Constructed PER RUN, not per orchestrator. It used to be a pair of fields on
// the class, which read as a cross-cutting guard and was not one: the provider
// builds a new orchestrator for every user action, so the pair was reset on
// every action and never throttled anything across two of them. A run is the
// scope over which it actually means something, and this makes that the scope
// it has.
export class StreamPersistence {
  private lastSaveAt = 0
  private readonly throttleMs: number

  constructor(throttleMs = 1000) {
    this.throttleMs = throttleMs
  }

  due(now: number): boolean {
    if (now - this.lastSaveAt <= this.throttleMs) return false
    this.lastSaveAt = now
    return true
  }
}

export class RawScriptGenerationOrchestrator {
  private services: RawScriptServices
  private callbacks: RawGenerationCallbacks
  private options: RawGenerationOptions
  // The metrics of the turn currently streaming, per conversation. It is held
  // here rather than passed back through the stream helpers because the two
  // of them return the PROSE and the tool calls, and the dozen turns that call
  // them each close their generation somewhere else — several branches later,
  // in a catch, or in the caller of the helper that streamed. Keyed by
  // conversation because two scripts can generate at once; a turn is
  // sequential within one conversation, so there is only ever one open draft
  // per key, and `takeTurnMetrics` removes it as it is read so a later
  // dispatch with no stream of its own cannot pick up the last turn's numbers.
  private openTurnMetrics = new Map<string, TurnMetricsDraft>()
  // The turn this class has OPENED and not yet closed, per conversation, and
  // whatever it has streamed into it so far. It is the orchestrator's own
  // record of its own dispatches rather than a reading of the reducer's state,
  // because the state is reached through `getConversation`, which answers from
  // a ref React reassigns on render — and nothing here can make React render.
  // A turn opened one line ago and a turn opened and filled ten awaits ago
  // therefore have to be answerable without asking React anything.
  private openTurns = new Map<string, { body: string }>()
  // The run's own mirror of the conversation it is writing, maintained from
  // the dispatches below for the same reason openTurns is: the loop folds this
  // conversation between every round to decide what to do next, and the only
  // other way to read it back is `getConversation`, which answers from a ref
  // React reassigns when it re-renders — and an await is not a render. A round
  // that finished one statement ago has to be foldable regardless.
  private runLog = new Map<string, Generation[]>()
  // The round the run is currently performing, stamped onto every generation
  // it opens. Held here rather than threaded through the twenty START_GENERATION
  // sites for the same reason the empty-turn substitution is: this is the one
  // place every dispatch passes through.
  private currentRound: GenerationRound | undefined
  private streamSaves = new StreamPersistence()
  // The corpus a conversation's run was grounded in, so a rewrite triggered
  // later in the same session sees the same exemplars without retrieving again
  private runExamples = new Map<string, ExampleScript[]>()

  constructor(
    services: RawScriptServices,
    callbacks: RawGenerationCallbacks,
    options: RawGenerationOptions = {}
  ) {
    this.services = services
    this.callbacks = callbacks
    this.options = options
  }

  // A generation run builds each request from scratch, so its largest request
  // is one section's worth of outline and script-so-far, reserved below. A
  // rewrite instead replays the stored conversation, where the request
  // messages dwarf the responses and the outline and script are already
  // counted — so the two paths size the corpus differently.
  private async retrieveExamples(
    request: GenerationRequest,
    conversation: RawConversation | undefined,
    plan: LengthPlan,
    replaysHistory = false
  ): Promise<ExampleScript[]> {
    try {
      const systemPrompt = getSystemPrompt(plan)
      const conversationTokens = conversation
        ? conversation.generations.reduce(
            (total: number, generation) =>
              total +
              generation.response.length +
              (replaysHistory
                ? generation.messages.reduce((sum, message) => sum + message.content.length, 0)
                : 0),
            0
          )
        : 0
      const optimalExampleCount = getRecommendedExampleCount(
        systemPrompt,
        Math.ceil(conversationTokens / 4),
        replaysHistory ? 0 : estimateSectionContextTokens(plan.totalWords, plan.sectionCount)
      )

      return await this.services.exampleService.searchExamples(
        request.prompt,
        optimalExampleCount
      )
    } catch (error) {
      console.warn('Failed to retrieve examples', error)
      return []
    }
  }

  // The run's exemplars for a rewrite that did not start from generateScript
  // (a manual regeneration or refinement after a reload), retrieved once per
  // conversation. retrieveExamples swallows failures, so this degrades to an
  // ungrounded rewrite rather than failing the request.
  private async examplesFor(
    conversationId: string,
    query: string,
    plan: LengthPlan,
    conversation?: RawConversation
  ): Promise<ExampleScript[]> {
    const cached = this.runExamples.get(conversationId)
    if (cached) return cached

    const examples = await this.retrieveExamples({ prompt: query }, conversation, plan, true)
    this.runExamples.set(conversationId, examples)
    return examples
  }

  // Every conversation action this class dispatches goes through here, which
  // makes this the one place that knows both whether a turn is open and what
  // has been written into it — without asking React, which cannot be made to
  // answer on demand.
  //
  // It is also where the guarantee the whole file depends on is enforced. A
  // generation stored with an empty response and no tool calls fails the
  // serializer's admission test and is dropped from the saved file outright,
  // taking the record of the request, its prompt and its cost with it. So a
  // turn is never closed empty: a completion carrying nothing to store is
  // closed with a line saying exactly that. Enforcing it HERE rather than at
  // each of the twenty completions covers, in one place, the shape the
  // per-path guards keep missing — a stream that SUCCEEDS while carrying no
  // prose and no call at all, which reaches none of them.
  private dispatch(action: RawConversationAction): void {
    if (action.type === 'START_GENERATION') {
      // The round is stamped here, once, rather than at each of the twenty
      // sites that open a turn — including the several a single section round
      // opens while a body is refused and asked for again, which all belong to
      // the same round.
      const round = action.round ?? this.currentRound
      this.openTurns.set(action.conversationId, { body: '' })
      this.appendToRunLog(action.conversationId, {
        messages: action.messages,
        response: '',
        timestamp: Date.now(),
        exampleIds: action.exampleIds,
        round
      })
      this.callbacks.dispatch({ ...action, round })
      return
    } else if (action.type === 'UPDATE_CURRENT_GENERATION') {
      const open = this.openTurns.get(action.conversationId)
      if (open) open.body = action.response
      this.amendRunLog(action.conversationId, generation => {
        generation.response = action.response
        if (action.toolCalls) generation.toolCalls = action.toolCalls
      })
    } else if (action.type === 'COMPLETE_GENERATION') {
      this.openTurns.delete(action.conversationId)
      // Trimmed, not merely truthy: a response of nothing but whitespace is
      // written into the file as a blank block, and the parser reading it back
      // trims it to nothing and drops the generation just the same.
      if (!action.response.trim() && !(action.toolCalls && action.toolCalls.length > 0)) {
        const substituted = { ...action, response: EMPTY_TURN_RECORD }
        this.recordCompletion(substituted)
        this.callbacks.dispatch(substituted)
        return
      }
      this.recordCompletion(action)
    } else if (
      action.type === 'GENERATION_RESTARTED' ||
      action.type === 'GENERATIONS_DISCARDED'
    ) {
      // Both throw away what a previous run left in the conversation, so any
      // turn this class still thinks is open belongs to a run that no longer
      // has generations to close
      this.openTurns.delete(action.conversationId)
      // Only a discard empties the conversation; a restart keeps every
      // generation and clears the run's UI state, so the mirror keeps them too
      if (action.type === 'GENERATIONS_DISCARDED') {
        this.runLog.set(action.conversationId, [])
      }
    }

    this.callbacks.dispatch(action)
  }

  // The mirror is written only while a run owns the conversation; outside a
  // run there is nothing to keep in step with and nothing reading it.
  private appendToRunLog(conversationId: string, generation: Generation): void {
    this.runLog.get(conversationId)?.push(generation)
  }

  private amendRunLog(conversationId: string, amend: (generation: Generation) => void): void {
    const log = this.runLog.get(conversationId)
    const last = log?.[log.length - 1]
    if (last) amend(last)
  }

  private recordCompletion(
    action: Extract<RawConversationAction, { type: 'COMPLETE_GENERATION' }>
  ): void {
    this.amendRunLog(action.conversationId, generation => {
      generation.response = action.response
      if (action.toolCalls) generation.toolCalls = action.toolCalls
      if (action.metrics) generation.metrics = action.metrics
    })
  }

  // The conversation as this run has written it, folded into the document the
  // planner reads. `settled` says the last generation is one this run closed
  // itself, which is the finish evidence a reader of a conversation at rest
  // has to guess at from position.
  private projectRun(conversation: RawConversation, settled: boolean): ProjectedDocument {
    const generations = this.runLog.get(conversation.id) ?? conversation.generations
    return projectConversation(
      { ...conversation, generations },
      null,
      { lastGenerationSettled: settled }
    )
  }

  // Opens the record of one provider request. Called by the two stream
  // helpers at the top of their streams, which is as close to the request
  // going out as this class gets.
  private beginTurnMetrics(conversationId: string): TurnMetricsDraft {
    const draft: TurnMetricsDraft = { startedAt: Date.now() }
    this.openTurnMetrics.set(conversationId, draft)
    return draft
  }

  // The frames that describe the REQUEST rather than its prose. They have been
  // in the stream since the frame protocol landed and nothing read them: the
  // cost summary estimated tokens from a character count while the provider's
  // own numbers went past unread, and `Generation.cachedTokens` was declared,
  // stored, parsed and asserted on without one line anywhere setting it.
  private observeMetricFrame(draft: TurnMetricsDraft, frame: ProviderFrame): void {
    if (frame.kind === 'firstToken') {
      // First one wins: a stream that somehow reported it twice is reporting
      // the same first token, and the earlier reading is the true one
      draft.firstTokenAt ??= frame.at
      return
    }
    if (frame.kind === 'usage') {
      // Assigned field by field, not spread: a provider may send usage
      // without the cache breakdown, and spreading would overwrite a number
      // that arrived with an explicit undefined
      if (frame.promptTokens !== undefined) draft.promptTokens = frame.promptTokens
      if (frame.completionTokens !== undefined) draft.completionTokens = frame.completionTokens
      if (frame.cachedTokens !== undefined) draft.cachedTokens = frame.cachedTokens
      return
    }
    if (frame.kind === 'finished' && frame.reason) {
      draft.finishReason = frame.reason
    }
  }

  // Closes the open turn's record and hands it to the dispatch that stores it.
  // Returns undefined when the turn never reached a stream — a request that
  // threw on its way out has nothing measured to report, and metrics are
  // optional precisely so that such a turn can say nothing rather than lie
  // about zero.
  private takeTurnMetrics(conversationId: string, aborted = false): GenerationMetrics | undefined {
    const draft = this.openTurnMetrics.get(conversationId)
    if (!draft) return undefined
    this.openTurnMetrics.delete(conversationId)

    return {
      startedAt: draft.startedAt,
      endedAt: Date.now(),
      ...(draft.firstTokenAt !== undefined ? { firstTokenAt: draft.firstTokenAt } : {}),
      ...(draft.promptTokens !== undefined ? { promptTokens: draft.promptTokens } : {}),
      ...(draft.completionTokens !== undefined ? { completionTokens: draft.completionTokens } : {}),
      ...(draft.cachedTokens !== undefined ? { cachedTokens: draft.cachedTokens } : {}),
      ...(draft.finishReason ? { finishReason: draft.finishReason } : {}),
      ...(aborted ? { aborted: true } : {})
    }
  }

  private persistConversation(conversationId: string): void {
    const conversation = this.callbacks.getConversation(conversationId)
    if (conversation) {
      this.callbacks.saveConversation(conversation)
    }
  }

  // Collapses a provider stream back to the prose it carried. Everything the
  // stream reports about the request itself — first token, usage, finish
  // reason — is deliberately ignored here: this is the path that builds the
  // markdown a generation stores, and only text belongs in it.
  private async streamToString(
    stream: AsyncIterable<ProviderFrame>,
    conversationId: string,
    abortSignal?: AbortSignal,
    onChunk?: (accumulated: string) => void
  ): Promise<string> {
    let accumulated = ''
    const metrics = this.beginTurnMetrics(conversationId)
    // Reasoning, and how much of it has been reported. Most of this app's
    // turns come through here rather than the tool path — the outline, a
    // section regenerated from the button, every critique — so a reasoning
    // model reporting nothing but this would leave all of them silent.
    let thinking = ''
    let unreported = 0

    for await (const frame of stream) {
      // Above the text filter, because everything it reads is a frame the
      // filter throws away
      this.observeMetricFrame(metrics, frame)

      if (isThinkingFrame(frame)) {
        thinking += frame.delta
        unreported += frame.delta.length
        // Stepped the same way prose is, and for the same reason: reasoning
        // arrives a few characters at a time, and dispatching every fragment
        // would re-render the panel many times a second to no purpose.
        if (unreported >= THINKING_STEP_CHARS || thinking === frame.delta) {
          unreported = 0
          this.dispatch({ type: 'MODEL_THINKING_STREAMED', conversationId, thinking })
        }
        continue
      }

      // Below the filter, not above it: the stream now ends with `finished` and
      // `usage` frames, and checking there would turn an abort arriving after
      // the last text delta into a thrown run instead of one that keeps the
      // prose it had. This ticks on prose only, which is what it did before
      // frames existed.
      if (!isTextFrame(frame)) continue

      if (abortSignal?.aborted) {
        throw new Error('Generation aborted')
      }

      accumulated += frame.delta

      if (onChunk) {
        onChunk(accumulated)
      }

      // Throttled save during streaming
      if (this.streamSaves.due(Date.now())) this.persistConversation(conversationId)
    }

    return accumulated
  }

  // The tool-path counterpart of streamToString. It keeps everything the
  // stream carries rather than only the prose: a run written by tool call needs
  // the arguments, the finish reason and the text a model that ignored the
  // tools replied with, and has to decide between them once the stream ends.
  //
  // `onProgress` is called with the response as it stands, so a caller can
  // render a body that is still arriving: on the first frame that carries
  // anything, every PROGRESS_STEP_CHARS after that, and once more when the
  // stream ends holding material the last notification did not include.
  private async streamResponse(
    stream: AsyncIterable<ProviderFrame>,
    conversationId: string,
    abortSignal?: AbortSignal,
    onProgress?: (response: StreamedResponse) => void
  ): Promise<StreamedResponse> {
    const calls = new Map<number, StreamedToolCall>()
    const metrics = this.beginTurnMetrics(conversationId)
    let text = ''
    let thinking = ''
    let finishReason: string | null = null
    let finishedCleanly = false

    const snapshot = (): StreamedResponse => ({
      text,
      thinking,
      calls: [...calls.values()].sort((a, b) => a.index - b.index),
      finishReason,
      finishedCleanly
    })

    // How much has arrived since the last notification, and whether there has
    // been one (see PROGRESS_STEP_CHARS)
    let unnotified = 0
    let notified = false

    const notify = (): void => {
      unnotified = 0
      notified = true
      // Reported from here rather than from a caller's onProgress, because
      // every tool-path turn has the same silence to explain — the outline, a
      // section, a critique — and a caller that renders only a section body
      // would drop it. It is dispatched before onProgress so the reasoning is
      // on screen even when the body is still empty, which for a reasoning
      // model is most of the turn.
      if (thinking) {
        this.dispatch({
          type: 'MODEL_THINKING_STREAMED',
          conversationId,
          thinking
        })
      }
      onProgress?.(snapshot())
    }

    for await (const frame of stream) {
      this.observeMetricFrame(metrics, frame)

      if (frame.kind === 'finished') {
        finishReason = frame.reason
        // Only these two mean the model stopped because it was done. A
        // truncation ('length') or a stream that simply ends leaves the body
        // half-written however well-formed its JSON happens to look.
        finishedCleanly = frame.reason === 'stop' || frame.reason === 'tool_calls'
        continue
      }

      if (isTextFrame(frame)) {
        // Checked below the filter, as the prose path does: an abort arriving
        // after the last content delta must not turn into a thrown run
        if (abortSignal?.aborted) throw new Error('Generation aborted')
        text += frame.delta
        unnotified += frame.delta.length
      } else if (isThinkingFrame(frame)) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')
        // Counted towards the notification step like any other arrival, which
        // is the whole point: a reasoning model can spend half a minute here,
        // and a caller that is never notified has nothing to show for it.
        thinking += frame.delta
        unnotified += frame.delta.length
      } else if (isToolCallFrame(frame)) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')
        // Keyed on index, never on id: the id arrives with the first fragment
        // of a call and on no fragment after it
        const existing = calls.get(frame.index)
        const call: StreamedToolCall = existing ?? {
          index: frame.index,
          id: frame.id ?? '',
          name: frame.name,
          arguments: ''
        }
        if (frame.id) call.id = frame.id
        if (frame.name) call.name = frame.name
        call.arguments += frame.argumentsDelta
        calls.set(frame.index, call)
        unnotified += frame.argumentsDelta.length
      } else {
        continue
      }

      if (!notified || unnotified >= PROGRESS_STEP_CHARS) notify()

      if (this.streamSaves.due(Date.now())) this.persistConversation(conversationId)
    }

    // The last stretch, so what a caller rendered last is the WHOLE body and
    // not the body up to the final step boundary
    if (unnotified > 0) notify()

    return snapshot()
  }

  // Runs one tool-path stream with the guarantee every turn on that path
  // needs: whatever happens, the generation the turn opened is CLOSED. A
  // stream that throws — the user stopping the run, a dropped connection —
  // would otherwise leave the generation open holding whatever had streamed
  // into it, stored as an ordinary generation with no tool calls on it, which
  // is the one shape no reader folds out (D6); and an abort landing before the
  // first delta would leave it holding the empty response the deployed parser
  // drops, prompt and all (D1). There is no call id to record here, because
  // the call never finished arriving, so the turn is closed with a one-line
  // record of what happened — the same shape the outline path already uses for
  // a reply that carried neither a call nor text.
  private async streamOrClose(
    conversationId: string,
    subject: string,
    run: () => Promise<StreamedResponse>
  ): Promise<StreamedResponse> {
    try {
      return await run()
    } catch (error) {
      // Whatever streamed in before the throw is discarded rather than kept,
      // unlike closeOpenGeneration below: half a section_write body stored as
      // an ordinary generation with no tool calls on it is the one shape no
      // reader folds out (D6).
      if (this.openTurns.has(conversationId)) {
        this.dispatch({
          type: 'COMPLETE_GENERATION',
          conversationId,
          response: `${subject}: the request ended before the model finished.`,
          // Marked aborted: this is the path where the stream did not reach its
          // own end, whether the user stopped it or the connection did
          metrics: this.takeTurnMetrics(conversationId, true)
        })
        this.persistConversation(conversationId)
      }
      throw error
    }
  }

  // The prose path's counterpart to streamOrClose, for the failure paths that
  // are not one wrapped stream: every turn on every path opens its generation
  // with START_GENERATION, which appends one holding an empty response, so a
  // path that returns or rethrows without a COMPLETE_GENERATION leaves that
  // empty generation in state. The next save writes it with no response block,
  // and the deployed parser DROPS it — the request, its prompt and its cost
  // are simply gone from the file (see conversationParser).
  //
  // Only an EMPTY response is replaced. Several of these paths deliberately
  // keep whatever streamed in before the failure — a stopped run settles as a
  // draft still holding its half-written section — so a turn that already has
  // prose is closed by leaving it exactly as it stands, heading and all.
  //
  // Both questions — is a turn open, and does it already hold prose — are
  // answered from `openTurns`, which this class writes as it dispatches. The
  // obvious alternative, reading the conversation back through
  // `getConversation`, cannot answer either one reliably: that callback reads a
  // ref React reassigns when it re-renders, and an await is not a render, so a
  // turn opened moments ago may not be in the state it returns.
  private closeOpenGeneration(conversationId: string, subject: string): void {
    const open = this.openTurns.get(conversationId)
    if (!open || open.body) return

    this.dispatch({
      type: 'COMPLETE_GENERATION',
      conversationId,
      response: `${subject}: the request ended before the model finished.`,
      metrics: this.takeTurnMetrics(conversationId, true)
    })
    this.persistConversation(conversationId)
  }

  // Write the outline by tool call. A compliant model's FIRST act here is a
  // grounding_select, because that is what its own schema tells it to do — so
  // the turn that answers it is the normal case, not an error, and the outline
  // arrives on the turn after. Bounded by MAX_TOOL_HANDSHAKES so a model that
  // never gets to outline_write cannot spin against a paid API.
  //
  // Returns the markdown outline; throws when nothing usable was written,
  // rather than letting an empty response stand as one.
  private async writeOutlineWithTools(args: {
    conversationId: string
    request: GenerationRequest
    outlineUserPrompt: string
    outlineMessages: ChatMessage[]
    exampleIds: string[]
    examples: ExampleScript[]
    systemPrompt: string
    grounding: RunGrounding
    abortSignal?: AbortSignal
  }): Promise<string> {
    const { conversationId } = args
    let toolTurns: ProviderTurn[] = []

    for (let turn = 0; turn <= MAX_TOOL_HANDSHAKES; turn++) {
      if (args.abortSignal?.aborted) throw new Error('Generation aborted')

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: args.outlineMessages,
        exampleIds: args.exampleIds.length > 0 ? args.exampleIds : undefined
      })

      const stream = this.services.scriptService.generateScript(
        { ...args.request, prompt: args.outlineUserPrompt },
        withGenerationSystemPrompt(args.outlineMessages, args.systemPrompt),
        args.examples,
        args.abortSignal,
        { tools: WRITING_TOOLS, toolTurns }
      )

      const response = await this.streamOrClose(conversationId, 'No outline was written', () =>
        this.streamResponse(
          stream,
          conversationId,
          args.abortSignal,
          streamed => {
            // Only the title is readable while the call streams: the section
            // plan is a nested array, and the partial scanner deliberately
            // reads top-level strings only. A title on its own is still worth
            // showing — it is what the page has been waiting for.
            const call = streamed.calls.find(entry => entry.name === OUTLINE_WRITE_TOOL)
            const partial = call ? toolField(call, 'title') : streamed.text
            if (!partial) return
            this.dispatch({
              type: 'UPDATE_CURRENT_GENERATION',
              conversationId,
              response: call ? `# ${partial}` : partial
            })
          }
        )
      )

      const call = response.calls.find(entry => entry.name === OUTLINE_WRITE_TOOL)

      if (call) {
        const rendered = response.finishedCleanly
          ? renderOutlineFromToolCall(call.arguments)
          : null

        if (rendered) {
          this.dispatch({
            type: 'COMPLETE_GENERATION',
            metrics: this.takeTurnMetrics(conversationId),
            conversationId,
            response: rendered,
            toolCalls: [{
              id: call.id,
              name: OUTLINE_WRITE_TOOL,
              title: toolField(call, 'title'),
              status: 'accepted'
            }]
          })
          return rendered
        }

        // The call produced no usable plan — malformed arguments, no title, no
        // sections, or a stream that never finished. `response.text` is empty
        // for a tool-only reply, and a generation stored with an empty response
        // is dropped outright by the deployed parser — the record of the
        // request and the prompt block written for it both go with it, and the
        // following generation keeps its own prompt regardless (D1). So what
        // happened is recorded in one non-empty line before the run fails.
        const reason = response.finishedCleanly
          ? `REJECTED: those ${OUTLINE_WRITE_TOOL} arguments did not describe a usable plan.`
          : `REJECTED: the ${OUTLINE_WRITE_TOOL} call did not finish ` +
            `(${response.finishReason ?? 'the stream ended without a finish reason'}).`
        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: `No outline was written: ${reason}`,
          toolCalls: [{ id: call.id, name: OUTLINE_WRITE_TOOL, status: 'rejected', reason }]
        })
        this.persistConversation(conversationId)
        throw new Error('Failed to parse outline from LLM response')
      }

      const stray = namedCallOf(response)

      if (!stray) {
        // A model that answered in prose anyway is not a failed run: the
        // markdown outline is parsed exactly as it always was, and the run
        // carries on with whichever the model gave us.
        //
        // But a prose reply is judged on the same finish as a call (D6): a
        // reply cut off at "## Awak" still parses as an outline, and storing
        // it would silently shorten the whole script to the sections that
        // arrived. Neither an empty reply nor a truncated one is an outline,
        // so what happened is recorded as itself (D1) and the run fails on it.
        if (!response.text.trim() || !response.finishedCleanly) {
          const reason = response.text.trim()
            ? `the reply was cut off (${response.finishReason ?? 'the stream ended without a finish reason'})`
            : 'the model replied with neither a tool call nor text'
          this.dispatch({
            type: 'COMPLETE_GENERATION',
            metrics: this.takeTurnMetrics(conversationId),
            conversationId,
            response: `No outline was written: ${reason}.`
          })
          this.persistConversation(conversationId)
          throw new Error('Failed to parse outline from LLM response')
        }

        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: response.text
        })
        return response.text
      }

      const answer = stray.name === GROUNDING_SELECT_TOOL
        ? answerGroundingSelect(args.grounding, OUTLINE_WRITE_TOOL)
        : answerWrongTool(stray.name as string, OUTLINE_WRITE_TOOL, 'The outline is not written yet.')
      if (stray.name === GROUNDING_SELECT_TOOL) args.grounding.done = true

      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: answer.record,
        toolCalls: [{
          id: stray.id,
          name: stray.name as WritingToolName,
          status: answer.status,
          reason: answer.content
        }]
      })
      this.persistConversation(conversationId)

      toolTurns = [
        {
          role: 'assistant',
          toolCalls: [{ id: stray.id, name: stray.name as string, arguments: stray.arguments }]
        },
        { role: 'tool', toolCallId: stray.id, content: answer.content }
      ]
    }

    throw new Error(`The model never called ${OUTLINE_WRITE_TOOL}`)
  }

  // One attempt at one section on the tool path: the request goes out with the
  // whole tool list (D4) and any rejection exchange from the previous attempt,
  // and the body streams into the current generation as it arrives.
  //
  // The generation is STARTED here but deliberately not completed: only the
  // caller, having measured the body, knows whether this attempt was accepted,
  // rejected or waived.
  private async runToolSectionAttempt(args: {
    conversationId: string
    sectionTitle: string
    userMessage: string
    messages: ChatMessage[]
    sendMessages: ChatMessage[]
    toolTurns: ProviderTurn[]
    abortSignal?: AbortSignal
  }): Promise<StreamedResponse> {
    this.dispatch({
      type: 'START_GENERATION',
      conversationId: args.conversationId,
      messages: args.messages
    })

    this.dispatch({
      type: 'SET_GENERATION_PROGRESS',
      conversationId: args.conversationId,
      isComplete: false,
      sectionTitle: args.sectionTitle
    })

    const stream = this.services.scriptService.regenerateSection(
      {
        prompt: args.userMessage,
        conversationId: args.conversationId,
        sectionTitle: args.sectionTitle
      },
      args.sendMessages,
      args.abortSignal,
      { tools: WRITING_TOOLS, toolTurns: args.toolTurns }
    )

    return this.streamResponse(
      stream,
      args.conversationId,
      args.abortSignal,
      response => {
        const call = sectionCallOf(response)
        const body = call ? toolField(call, 'body') : response.text
        if (!body) return
        // Byte-identical to what the prose path renders while streaming, so
        // the reducer, the reading view, performance mode and the word meter
        // all keep working with no change at all
        this.dispatch({
          type: 'UPDATE_CURRENT_GENERATION',
          conversationId: args.conversationId,
          response: ensureSectionHeading(args.sectionTitle, body)
        })
      }
    )
  }

  // Write one section by tool call, rejecting a body outside the word window
  // and asking for it again, until it lands or the attempts run out.
  //
  // This replaces the old one-shot retry, which kept whichever of two attempts
  // happened to be closer — so a section could be accepted for being the better
  // of two failures. Here a failure is a REJECTION: it is stored as one, folded
  // out of the document, and answered with a tool result telling the model its
  // call did not land.
  //
  // Two things bound the loop, because an unbounded rewrite loop runs against a
  // paid API inside a browser tab: MAX_SECTION_ATTEMPTS per section, and a
  // per-run rejection budget shared by every section. When either runs out the
  // closest attempt is accepted anyway and recorded as WAIVED (D5) — the user
  // chose having the script over not having it, and the waiver stays visible
  // rather than reading as a clean acceptance.
  //
  // A model that answers in prose despite being offered the tools is not
  // failing: it is a model the tool path cannot drive, so the section falls
  // back to the prose path's own corrective retry, which the caller runs.
  private async writeSectionWithTools(args: {
    conversationId: string
    sectionTitle: string
    userMessage: string
    storedSystemPrompt: string
    systemPrompt: string
    history: ChatMessage[]
    budget: { remaining: number }
    grounding: RunGrounding
    abortSignal?: AbortSignal
  }): Promise<{ kind: 'written'; body: string } | { kind: 'prose'; text: string }> {
    const { conversationId, sectionTitle } = args
    const attempts: Array<{
      call: StreamedToolCall
      body: string
      wordCount: number
      // D6, carried per attempt: the waiver chooses among attempts, so it has
      // to know which of them actually arrived whole
      finishedCleanly: boolean
    }> = []

    let toolTurns: ProviderTurn[] = []
    // Writing attempts and handshake turns are counted apart: answering a
    // grounding_select or refusing the wrong tool must not spend the section's
    // attempts, and must not be able to spin either.
    let attempt = 0
    let handshakes = 0

    for (;;) {
      if (args.abortSignal?.aborted) throw new Error('Generation aborted')

      const messages: ChatMessage[] = [
        { role: 'system', content: args.storedSystemPrompt },
        ...args.history,
        { role: 'user', content: args.userMessage }
      ]

      const response = await this.streamOrClose(
        conversationId,
        `No section was written for "${sectionTitle}"`,
        () => this.runToolSectionAttempt({
          conversationId,
          sectionTitle,
          userMessage: args.userMessage,
          messages,
          sendMessages: withGenerationSystemPrompt(messages, args.systemPrompt),
          toolTurns,
          abortSignal: args.abortSignal
        })
      )

      const call = sectionCallOf(response)
      const stray = call ? undefined : namedCallOf(response)

      if (!call && !stray) {
        // Nothing was called at all: this is a model answering in prose despite
        // being offered the tools, which the caller's prose retry handles.
        //
        // A prose reply is judged on the same finish a call is (D6). A reply
        // the provider truncated is a fragment of a section, and storing it
        // would file half a section as the section — so it is recorded as what
        // happened, in a line with no heading that no reader reads as a body,
        // and the section fails rather than being written from the fragment.
        if (!response.finishedCleanly) {
          const reason = response.finishReason ?? 'the stream ended without a finish reason'
          this.dispatch({
            type: 'COMPLETE_GENERATION',
            metrics: this.takeTurnMetrics(conversationId),
            conversationId,
            response: `No section was written for "${sectionTitle}": the reply was cut off (${reason}).`
          })
          this.persistConversation(conversationId)
          throw new Error(
            `The section "${sectionTitle}" was never written: the reply was cut off (${reason})`
          )
        }

        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: ensureSectionHeading(sectionTitle, response.text)
        })
        return { kind: 'prose', text: response.text }
      }

      // A call arrived that was not this section's section_write — a compliant
      // model's opening grounding_select, a second one, or any other tool.
      // Answered here and asked again with the tools still attached; falling
      // through to the prose retry would strand a tool-calling model, and
      // taking the call's text as a body would file an empty section.
      if (stray) {
        const answer = stray.name === GROUNDING_SELECT_TOOL
          ? answerGroundingSelect(args.grounding, SECTION_WRITE_TOOL)
          : answerWrongTool(
              stray.name as string,
              SECTION_WRITE_TOOL,
              `The section being written is "${sectionTitle}".`
            )
        if (stray.name === GROUNDING_SELECT_TOOL) args.grounding.done = true

        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: answer.record,
          toolCalls: [{
            id: stray.id,
            name: stray.name as WritingToolName,
            status: answer.status,
            reason: answer.content
          }]
        })
        this.persistConversation(conversationId)

        handshakes += 1
        if (handshakes > MAX_TOOL_HANDSHAKES) {
          throw new Error(
            `The model kept calling tools other than ${SECTION_WRITE_TOOL} for the section ` +
            `"${sectionTitle}"`
          )
        }

        toolTurns = [
          {
            role: 'assistant',
            toolCalls: [{ id: stray.id, name: stray.name as string, arguments: stray.arguments }]
          },
          { role: 'tool', toolCallId: stray.id, content: answer.content }
        ]
        continue
      }

      const writingCall = call as StreamedToolCall
      const namedTitle = toolField(writingCall, 'title').trim()

      // MAJOR: the body is filed under the title the CALL names, so a call
      // naming another section is refused rather than stored as this one.
      if (namedTitle !== sectionTitle) {
        const answer = answerWrongSection(
          writingCall.name as string,
          namedTitle || '(none)',
          sectionTitle
        )

        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: answer.record,
          toolCalls: [{
            id: writingCall.id,
            name: writingCall.name as WritingToolName,
            title: namedTitle || undefined,
            status: 'rejected',
            reason: answer.content
          }]
        })
        this.persistConversation(conversationId)

        handshakes += 1
        if (handshakes > MAX_TOOL_HANDSHAKES) {
          throw new Error(
            `The model kept writing a section other than "${sectionTitle}"`
          )
        }

        toolTurns = [
          {
            role: 'assistant',
            toolCalls: [{
              id: writingCall.id,
              name: writingCall.name as string,
              arguments: writingCall.arguments
            }]
          },
          { role: 'tool', toolCallId: writingCall.id, content: answer.content }
        ]
        continue
      }

      attempt += 1
      const body = toolField(writingCall, 'body')
      const wordCount = countWords(body)
      const name = writingCall.name as WritingToolName

      if (response.finishedCleanly && !shouldRetrySection(wordCount)) {
        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: ensureSectionHeading(sectionTitle, body),
          toolCalls: [{ id: writingCall.id, name, title: sectionTitle, status: 'accepted', wordCount }]
        })
        return { kind: 'written', body }
      }

      attempts.push({ call: writingCall, body, wordCount, finishedCleanly: response.finishedCleanly })

      if (attempt >= MAX_SECTION_ATTEMPTS || args.budget.remaining <= 0) {
        // The waiver lands in THIS generation, which is still open: the kept
        // body has to be the last one stored for its title, because every
        // reader that is not the projection — consolidation, the review pass,
        // the export of a conversation written before tool calls — resolves a
        // repeated section by taking the last.
        //
        // Only cleanly-finished, non-empty attempts are candidates (D6). The
        // waiver D5 grants is for a section that will not land in the WORD
        // WINDOW — the user chose "better to have the script than not" about a
        // section that is the wrong length, not about a half-sentence that
        // never arrived. So an aborted or 'length'-truncated body is not a
        // thing there is any version of having: with no clean attempt to
        // waive, the section fails through the error path instead.
        //
        // Every exit from here closes THIS generation first. It is still open
        // and the refused body has already been streamed into it, so throwing
        // past it would leave that body stored as an ordinary generation with
        // no tool calls on it — unmarked, and folded out by nobody, which is
        // the outcome D6 forbids reached by another door.
        const last = attempts[attempts.length - 1]
        const refuseAttempt = (reason: string): void => {
          this.dispatch({
            type: 'COMPLETE_GENERATION',
            metrics: this.takeTurnMetrics(conversationId),
            conversationId,
            response: ensureSectionHeading(sectionTitle, last.body),
            toolCalls: [{
              id: last.call.id,
              name: (last.call.name ?? SECTION_WRITE_TOOL) as WritingToolName,
              title: sectionTitle,
              status: 'rejected',
              wordCount: last.wordCount,
              reason
            }]
          })
          this.persistConversation(conversationId)
        }

        if (args.abortSignal?.aborted) {
          refuseAttempt('REJECTED: the run was stopped before this section was written.')
          throw new Error('Generation aborted')
        }

        const candidates = attempts.filter(entry => entry.finishedCleanly && entry.wordCount > 0)
        if (candidates.length === 0) {
          // `response` is the last attempt's, so both wordings describe the
          // attempt whose body this generation is holding
          refuseAttempt(
            last.finishedCleanly
              ? 'REJECTED: that call finished carrying no section body at all.'
              : 'REJECTED: the call did not finish ' +
                `(${response.finishReason ?? 'the stream ended without a finish reason'}), so the ` +
                'section body arrived incomplete.'
          )
          throw new Error(
            `The section "${sectionTitle}" was never written: no attempt finished, so there is ` +
            'no complete body to keep'
          )
        }

        const best = candidates.reduce((closest, candidate) =>
          sectionDistanceFromTarget(candidate.wordCount) < sectionDistanceFromTarget(closest.wordCount)
            ? candidate
            : closest
        )
        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: ensureSectionHeading(sectionTitle, best.body),
          toolCalls: [{
            id: best.call.id,
            name: (best.call.name ?? SECTION_WRITE_TOOL) as WritingToolName,
            title: sectionTitle,
            status: 'waived',
            wordCount: best.wordCount,
            // Every candidate finished cleanly, and a cleanly finished body
            // inside the window was accepted and returned long before here —
            // so a waived body is always one that missed the window
            reason: buildSectionWaiver(best.wordCount, attempts.length)
          }]
        })
        this.persistConversation(conversationId)
        return { kind: 'written', body: best.body }
      }

      const reason = response.finishedCleanly
        ? buildSectionRejection(wordCount)
        : 'REJECTED: the call did not finish ' +
          `(${response.finishReason ?? 'the stream ended without a finish reason'}), so the ` +
          'section body arrived incomplete. Call the tool again with the whole section.'

      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        // Stored with its body even though the projection folds it out: a
        // rejected draft is evidence of what the run did, and a generation
        // written with an empty response is DROPPED by the already-deployed
        // parser, which loses the attempt and its prompt block together (D1).
        response: ensureSectionHeading(sectionTitle, body),
        toolCalls: [{ id: writingCall.id, name, title: sectionTitle, status: 'rejected', wordCount, reason }]
      })

      args.budget.remaining -= 1
      // Only the failed attempt is replayed, not every one before it: the model
      // needs to see the call it just made and why it was refused, and carrying
      // three discarded drafts of the same section would cost more context than
      // the section itself.
      toolTurns = [
        {
          role: 'assistant',
          toolCalls: [{ id: writingCall.id, name, arguments: writingCall.arguments }]
        },
        { role: 'tool', toolCallId: writingCall.id, content: reason }
      ]

      this.persistConversation(conversationId)
    }
  }

  async generateScript(
    request: GenerationRequest,
    conversation?: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!conversation) {
      throw new Error('Conversation is required for generation')
    }

    const conversationId = conversation.id
    // The requested length shapes the system prompt, the outline's section
    // count and the length the finished script is judged against
    const plan = buildLengthPlan(request.targetMinutes)
    // Read once, here, and held for the run: a setting changed halfway through
    // would otherwise add or drop a stage under a run already in progress.
    const pipeline = resolvePipeline({ reviewPass: this.options.reviewPassEnabled === true })
    this.streamSaves = new StreamPersistence()

    try {
      // A fresh run (first attempt, retry or resume) owns generation state from here
      this.dispatch({ type: 'GENERATION_RESTARTED', conversationId })
      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: { status: 'in-progress' }
      })

      // How this run will be written, decided once and pinned for its whole
      // length: the provider classes re-read the model setting on every
      // request, so a model changed halfway through a run would otherwise
      // switch the mode mid-script — leaving the remaining sections asking for
      // tool calls of a model that cannot make them.
      //
      // It is a run-level fact and NOT a pipeline field: what to write next has
      // nothing to do with how the words are asked for, which is why a
      // conversation begun in prose and continued with tools plans identically.
      const runPlan = planGeneration(this.callbacks.getScript?.(conversation.scriptId))
      const writesByTool = runPlan.mode === 'tools'
      // The rejection budget belongs to the run, not to a section: a model
      // systematically writing long would otherwise pay the per-section cap
      // over and over, once for every section of the script.
      const rejectionBudget = { remaining: SECTION_REJECTION_BUDGET }

      // Grounding is a run PRECONDITION, not a round: it is local retrieval
      // rather than a model turn, it happens once before any request, and a
      // model-initiated second grounding_select is refused from what the run
      // already holds rather than searched for again.
      const examples = await this.retrieveExamples(request, conversation, plan)
      const grounding: RunGrounding = { done: false, examples }
      this.runExamples.set(conversationId, examples)
      // The tool-mode system prompt differs from the prose one only in how the
      // words are asked for; the style rules underneath are the same file.
      const systemPrompt = writesByTool
        ? buildToolGenerationSystemPrompt(plan, examples)
        : buildGenerationSystemPrompt(plan, examples)
      // Examples are sent, never stored, so what a generation records is the
      // lean system prompt for the mode the run is in
      const storedSystemPrompt = writesByTool ? getToolSystemPrompt(plan) : getSystemPrompt(plan)
      const exampleIds = examples
        .map(example => String(example.metadata?.id ?? example.metadata?.filename ?? ''))
        .filter(Boolean)

      // Aggregate traceability (story 8.11): one selection per generation run
      // for each example that informs it
      recordExampleSelections(exampleIds)

      if (abortSignal?.aborted) throw new Error('Generation aborted')

      // The run claims the conversation: from here every dispatch is mirrored
      // into this log, which is what the planner folds between rounds.
      this.runLog.set(conversationId, [...conversation.generations])

      // An explicit fresh restart (story 1.8) discards the previous outline
      // and sections so nothing from the abandoned plan survives consolidation
      if (request.fresh && conversation.generations.length > 0) {
        this.dispatch({ type: 'GENERATIONS_DISCARDED', conversationId })
        this.callbacks.saveConversation({
          ...conversation,
          generations: [],
          updatedAt: Date.now()
        })
      }

      const context: RoundContext = {
        conversationId,
        conversation,
        request,
        plan,
        writesByTool,
        systemPrompt,
        storedSystemPrompt,
        examples,
        exampleIds,
        grounding,
        rejectionBudget,
        abortSignal
      }

      // The loop. Sequencing is a derived value rather than the order of the
      // statements it used to be, which is what makes a resume the same code
      // path as a first attempt: nothing here asks whether this run has been
      // here before, it asks what the conversation still needs.
      //
      // `settled` is false on the first fold and true after every round: the
      // conversation's last generation belongs to a PREVIOUS run until this
      // one has closed a generation of its own, and a body a previous run left
      // behind may have stopped mid-sentence.
      //
      // planNextRound returns null for ONE reason — the plan is satisfied. A
      // run that cannot go on (the round ceiling, a section asked for twice
      // and still unwritten) throws instead and lands in the catch below as
      // the failure it is, rather than falling through to the completion block
      // and reporting a script with holes in it as complete.
      let settled = false
      let reviewResult: ReviewPassResult | null = null
      let document = this.projectRun(conversation, settled)

      for (
        let planned = planNextRound(document, pipeline);
        planned;
        planned = planNextRound(document, pipeline)
      ) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        this.currentRound = planned
        try {
          reviewResult = await this.runRound(planned, context, document) ?? reviewResult
        } finally {
          this.currentRound = undefined
        }

        settled = true
        document = this.projectRun(conversation, settled)

        // The round-number source is the one thing that can turn this loop
        // into a silent infinite pass: a stage that opens no generation
        // records no round, the count stalls, and a record-gated stage is
        // re-planned every round until maxRounds. Every handler stores a
        // generation precisely so that cannot happen — and this says so out
        // loud rather than spinning against a paid API if one ever stops.
        if (document.rounds[document.rounds.length - 1]?.round !== planned.round) {
          throw new Error(`The ${planned.kind} round recorded nothing, so the run cannot advance`)
        }
      }

      // An abort can land on the last round's last frame and still leave the
      // loop ending naturally — the plan is satisfied, so there is no next
      // round to check the signal at the top of. Without this a stopped run
      // would be dispatched 'complete'.
      if (abortSignal?.aborted) throw new Error('Generation aborted')

      const outline = document.outline
      if (!outline) {
        throw new Error('Failed to parse outline from LLM response')
      }
      const scriptContent = document.fullContent

      // --- Complete ---
      this.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'complete',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length,
        sectionWordCounts: plannedSectionWordCounts(document)
      })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      // Revised sections change the totals, so count from the final content
      const totalWords = scriptContent
        .split('\n')
        .filter(line => !/^#{1,2}\s/.test(line))
        .reduce((sum, line) => sum + countWords(line), 0)
      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: {
          status: 'complete',
          title: outline.title,
          content: scriptContent,
          length: formatScriptLength(totalWords)
        }
      })

      if (reviewResult?.ran) {
        this.dispatch({
          type: 'REVIEW_PASS_COMPLETED',
          report: {
            conversationId,
            revised: reviewResult.marked,
            // The sections as reviewed, so the summary retires itself once the
            // script is restructured under it
            structure: parseMarkdownSections(scriptContent).map(section => section.title)
          }
        })
      }

      this.persistConversation(conversationId)

    } catch (error) {
      // Whatever went wrong, the turn that was in flight is closed first: the
      // prose outline and the prose section attempts are opened in this try
      // and completed only on success, so a failure between the two would
      // otherwise leave an empty generation here.
      this.closeOpenGeneration(conversationId, 'Nothing was written')

      // The user stopped the generation: keep what streamed in and settle as a draft
      if (abortSignal?.aborted) {
        this.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'idle'
        })

        this.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true
        })

        this.callbacks.appDispatch({
          type: 'UPDATE_SCRIPT',
          scriptId: conversation.scriptId,
          updates: { status: 'draft' }
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Script generation error:', error)

      this.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: { status: 'draft' }
      })

      this.persistConversation(conversationId)

      throw error
    } finally {
      this.currentRound = undefined
      this.runLog.delete(conversationId)
    }
  }

  // One round. The planner owns WHICH round; each handler owns everything
  // inside it — including, for a section, how many times a body may be refused
  // and asked for again, which is state no stateless planner can see.
  private async runRound(
    planned: PlannedRound,
    context: RoundContext,
    document: ProjectedDocument
  ): Promise<ReviewPassResult | null> {
    switch (planned.kind) {
      case 'outline':
        await this.runOutlineRound(context)
        return null
      case 'outline-critique':
        await this.runOutlineCritique(
          context.conversationId,
          context.request,
          context.plan,
          document.outline!,
          document.outlineText ?? '',
          context.writesByTool,
          context.abortSignal
        )
        return null
      case 'section':
        await this.runSectionRound(context, document, planned.sectionIndex ?? 0)
        return null
      case 'style-critique':
        return await this.runReviewPass(
          context.conversation,
          document,
          context.writesByTool,
          context.abortSignal
        )
      case 'review':
        // Reachable only if the pipeline ever switches `review` on. It is a
        // command today — a button the reader presses, repeatably — and
        // reviewScript stamps the round record the gate reads, so a pipeline
        // that did switch it on would not re-review a script reviewed by hand.
        throw new Error('The whole-script review is a command, not a planned round')
    }
  }

  // --- Phase 1: the plan ---
  private async runOutlineRound(context: RoundContext): Promise<void> {
    const { conversationId, request, plan, abortSignal } = context

    this.dispatch({
      type: 'SET_GENERATION_PHASE',
      conversationId,
      phase: 'generating_outline',
      currentSectionIndex: 0,
      totalSections: 0,
      sectionWordCounts: []
    })

    this.dispatch({
      type: 'SET_GENERATION_PROGRESS',
      conversationId,
      isComplete: false
    })

    const outlineUserPrompt = request.prompt + '\n\n' + (context.writesByTool
      ? getToolOutlineGenerationPrompt(plan)
      : getOutlineGenerationPrompt(plan))
    const outlineMessages: ChatMessage[] = [
      { role: 'system', content: context.storedSystemPrompt },
      { role: 'user', content: outlineUserPrompt }
    ]

    let outlineText: string

    if (context.writesByTool) {
      outlineText = await this.writeOutlineWithTools({
        conversationId,
        request,
        outlineUserPrompt,
        outlineMessages,
        exampleIds: context.exampleIds,
        examples: context.examples,
        systemPrompt: context.systemPrompt,
        grounding: context.grounding,
        abortSignal
      })
    } else {
      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: outlineMessages,
        exampleIds: context.exampleIds.length > 0 ? context.exampleIds : undefined
      })

      const outlineStream = this.services.scriptService.generateScript(
        { ...request, prompt: outlineUserPrompt },
        withGenerationSystemPrompt(outlineMessages, context.systemPrompt),
        context.examples,
        abortSignal
      )

      outlineText = await this.streamToString(
        outlineStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: outlineText
      })
    }

    this.persistConversation(conversationId)

    // Failing loudly rather than letting the artifact gate re-plan: a model
    // that cannot write a parseable plan will not write one on the next of
    // sixty-four attempts either, and every one of them is a paid request.
    if (!parseOutline(outlineText)) {
      throw new Error('Failed to parse outline from LLM response')
    }
  }

  // --- Phase 2: one section ---
  private async runSectionRound(
    context: RoundContext,
    document: ProjectedDocument,
    sectionIndex: number
  ): Promise<void> {
    const { conversationId, request, abortSignal } = context
    const outline = document.outline!
    const outlineText = document.outlineText ?? ''
    const section = outline.sections[sectionIndex]
    // What has been written so far, folded out of the conversation rather than
    // accumulated in a local string. The accumulator used to be built two
    // different ways — one for a fresh run, one for a resumed one — and the
    // review pass then swapped a third source in mid-run.
    const scriptContent = document.fullContent || `# ${outline.title}`

    this.dispatch({
      type: 'SET_GENERATION_PHASE',
      conversationId,
      phase: 'generating_section',
      outline,
      currentSectionIndex: sectionIndex,
      totalSections: outline.sections.length,
      sectionWordCounts: plannedSectionWordCounts(document)
    })

    // Upcoming outline entries let this section plant setups (story 8.10)
    const sectionPrompt = context.writesByTool
      ? getToolSectionGenerationPrompt(
          section.title,
          section.description,
          outline.sections.slice(sectionIndex + 1)
        )
      : getSectionGenerationPrompt(
          section.title,
          section.description,
          outline.sections.slice(sectionIndex + 1)
        )
    const sectionUserMessage = `Here is the outline for the full script:\n\n${outlineText}\n\nHere is what has been written so far:\n\n${scriptContent}\n\n${sectionPrompt}`

    const runSectionAttempt = async (userMessage: string): Promise<string> => {
      const sectionMessages: ChatMessage[] = [
        { role: 'system', content: context.storedSystemPrompt },
        { role: 'user', content: request.prompt },
        { role: 'assistant', content: outlineText },
        { role: 'user', content: userMessage }
      ]

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: sectionMessages
      })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false,
        sectionTitle: section.title
      })

      const sectionStream = this.services.scriptService.regenerateSection(
        { prompt: userMessage, conversationId, sectionTitle: section.title },
        withGenerationSystemPrompt(sectionMessages, context.systemPrompt),
        abortSignal
      )

      const text = await this.streamToString(
        sectionStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: ensureSectionHeading(section.title, accumulated)
          })
        }
      )

      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: ensureSectionHeading(section.title, text)
      })

      return text
    }

    // On the tool path the section is written by section_write, and a body
    // outside the window is rejected and asked for again rather than kept
    // for being the better of two failures. A model that replies in prose
    // regardless drops through to the prose path's own corrective retry
    // below, which is the whole point of keeping it.
    const written = context.writesByTool
      ? await this.writeSectionWithTools({
          conversationId,
          sectionTitle: section.title,
          userMessage: sectionUserMessage,
          storedSystemPrompt: context.storedSystemPrompt,
          systemPrompt: context.systemPrompt,
          history: [
            { role: 'user', content: request.prompt },
            { role: 'assistant', content: outlineText }
          ],
          budget: context.rejectionBudget,
          grounding: context.grounding,
          abortSignal
        })
      : null

    let sectionText = written
      ? (written.kind === 'written' ? written.body : written.text)
      : await runSectionAttempt(sectionUserMessage)
    const wordCount = countWords(sectionText)

    // A section well outside the word target gets one corrective retry;
    // the attempt closer to the target is kept
    if (written?.kind !== 'written' && shouldRetrySection(wordCount)) {
      this.persistConversation(conversationId)

      const retryText = await runSectionAttempt(
        `${sectionUserMessage}\n\n${buildRetryNote(wordCount)}`
      )

      sectionText = pickBetterSectionText(sectionText, retryText)

      if (sectionText !== retryText) {
        // The first attempt won: overwrite the retry generation's stored
        // response so consolidation-by-title lands on the kept text.
        //
        // The ONLY completion here that carries no metrics, deliberately:
        // it made no request of its own, and the metrics this generation
        // already holds are the retry request's, which is what it cost.
        // The reducer keeps them because the action omits them.
        this.dispatch({
          type: 'COMPLETE_GENERATION',
          conversationId,
          response: ensureSectionHeading(section.title, sectionText)
        })
      }
    }

    this.persistConversation(conversationId)
  }

  // Outline-critique step (story 8.9): one request checks the freshly
  // generated outline against the user's brief — coverage, escalation arc,
  // section balance — and either approves it or returns a full revised
  // outline. The exchange is stored as its own generation; a revised outline
  // is the latest parseable outline in the conversation, so it supersedes
  // generation 0 for section writing, resume and regeneration alike. A
  // failed critique never fails the run: the original outline is kept.
  private async runOutlineCritique(
    conversationId: string,
    request: GenerationRequest,
    plan: LengthPlan,
    outline: ScriptOutline,
    outlineText: string,
    writesByTool: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ outline: ScriptOutline; outlineText: string }> {
    const critiquePrompt = buildOutlineCritiquePrompt(request.prompt, outlineText, plan)
    const critiqueMessages: ChatMessage[] = [{ role: 'user', content: critiquePrompt }]

    try {
      if (writesByTool) {
        return await this.critiqueOutlineWithTools({
          conversationId,
          critiquePrompt,
          critiqueMessages,
          outline,
          outlineText,
          abortSignal
        })
      }

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: critiqueMessages
      })

      const critiqueStream = this.services.scriptService.regenerateSection(
        { prompt: critiquePrompt, conversationId, sectionTitle: OUTLINE_CRITIQUE_SECTION_TITLE },
        critiqueMessages,
        abortSignal
      )

      const critiqueText = await this.streamToString(
        critiqueStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      const result = parseOutlineCritiqueResponse(critiqueText)

      // A revision is stored as exactly the outline text, so latest-outline-
      // wins consumers (resume, regeneration) see it supersede generation 0
      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: result.revisedOutlineText ?? critiqueText
      })

      this.persistConversation(conversationId)

      if (result.revisedOutline && result.revisedOutlineText) {
        return { outline: result.revisedOutline, outlineText: result.revisedOutlineText }
      }
      return { outline, outlineText }
    } catch (error) {
      // Under a record gate a failure that stores NOTHING is indistinguishable
      // from a stage that never ran, so the round would fire again on the next
      // resume, and again. closeOpenGeneration replaces only an empty response,
      // so a critique that streamed something keeps it; one that failed before
      // a word arrived is closed with a line saying so — which is the record.
      this.closeOpenGeneration(conversationId, 'No outline critique was written')

      // A user abort must still end the whole run
      if (abortSignal?.aborted) throw error

      console.warn('Outline critique failed; keeping the generated outline as-is', error)
      return { outline, outlineText }
    }
  }

  // The outline critique on the tool path. It does the same two things the
  // prose critique above does — approve the plan, or come back with a revised
  // one — and RECORDS what it found while it does them.
  //
  // A finding here quotes nothing, and cannot: at this point the script is a
  // list of titles and one-line descriptions, so there is no passage to point
  // at. acceptCritique enforces that from the stage alone (see the outline
  // rule there), which is why the bodies map handed over is empty rather than
  // merely unused: there are no bodies, and saying so is the honest input.
  //
  // The revision is not additive to the critique — it is the same turn. A
  // revised plan may arrive as an outline_write call now that the tools are on
  // the request, or as the outline in prose the way it always has, and either
  // way THAT is what the generation stores as its response: every later
  // consumer reads the plan out of a generation's response, so rendering the
  // critique over the top of it would throw the revision away.
  private async critiqueOutlineWithTools(args: {
    conversationId: string
    critiquePrompt: string
    critiqueMessages: ChatMessage[]
    outline: ScriptOutline
    outlineText: string
    abortSignal?: AbortSignal
  }): Promise<{ outline: ScriptOutline; outlineText: string }> {
    const { conversationId, critiquePrompt, critiqueMessages, abortSignal } = args
    const kept = { outline: args.outline, outlineText: args.outlineText }
    let toolTurns: ProviderTurn[] = []

    for (let turn = 0; turn <= MAX_TOOL_HANDSHAKES; turn++) {
      if (abortSignal?.aborted) throw new Error('Generation aborted')

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: critiqueMessages
      })

      const critiqueStream = this.services.scriptService.regenerateSection(
        { prompt: critiquePrompt, conversationId, sectionTitle: OUTLINE_CRITIQUE_SECTION_TITLE },
        critiqueMessages,
        abortSignal,
        { tools: WRITING_TOOLS, toolTurns }
      )

      const response = await this.streamResponse(
        critiqueStream,
        conversationId,
        abortSignal,
        streamed => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: streamed.text
          })
        }
      )

      const outlineCall = response.calls.find(entry => entry.name === OUTLINE_WRITE_TOOL)
      const rendered = outlineCall && response.finishedCleanly
        ? renderOutlineFromToolCall(outlineCall.arguments)
        : null
      const call = response.calls.find(entry => entry.name === CRITIQUE_RECORD_TOOL)

      // Where a revised plan may be read from. A plan re-issued as a CALL is
      // one wherever it appears; a plan written out in prose counts only when
      // the model called nothing at all — the reply of a model answering this
      // step the way the prose path does. Prose alongside a tool call is
      // discarded here for the reason it is discarded everywhere else on this
      // path: only what a call carries is kept.
      const revision = rendered ?? (response.calls.length === 0 ? response.text : '')
      const result = parseOutlineCritiqueResponse(revision)
      const revised = result.revisedOutline && result.revisedOutlineText
        ? { outline: result.revisedOutline, outlineText: result.revisedOutlineText }
        : null

      if (call && response.finishedCleanly) {
        const outcome = this.acceptCritiqueCall(
          conversationId,
          NO_WRITTEN_BODIES,
          call,
          'outline',
          revised?.outlineText,
          outlineCall && rendered
            ? [{
                id: outlineCall.id,
                name: OUTLINE_WRITE_TOOL,
                title: toolField(outlineCall, 'title'),
                status: 'accepted' as const
              }]
            : undefined
        )
        if (outcome.ok) return revised ?? kept

        // Refused, and asked again with the tools still attached — the same
        // handshake every other refused call gets. A revision that rode along
        // with the refused critique is dropped with it: the turn is asked
        // again whole, and the model re-issues the plan if it still means it.
        toolTurns = [
          {
            role: 'assistant',
            toolCalls: [{ id: call.id, name: CRITIQUE_RECORD_TOOL, arguments: call.arguments }]
          },
          { role: 'tool', toolCallId: call.id, content: outcome.reason }
        ]
        continue
      }

      // No critique was recorded this turn. That is not a failure: a model
      // that revised the plan, or approved it in prose, has done the step's
      // original job, and the pass has never demanded more than that. The
      // record it leaves is the plan or the reply — never an empty response,
      // which the deployed parser drops outright, prompt block and all (D1).
      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: revised?.outlineText ?? (response.text.trim() ? response.text : EMPTY_TURN_RECORD),
        ...(outlineCall && rendered
          ? {
              toolCalls: [{
                id: outlineCall.id,
                name: OUTLINE_WRITE_TOOL,
                title: toolField(outlineCall, 'title'),
                status: 'accepted' as const
              }]
            }
          : {})
      })
      this.persistConversation(conversationId)
      return revised ?? kept
    }

    throw new Error(`The model never recorded a ${CRITIQUE_RECORD_TOOL}`)
  }

  // Style-review pass (story 8.5). One request judges the finished script
  // against the style rules and RECORDS what it found. It rewrites nothing.
  //
  // It used to rewrite up to MAX_REVIEW_REVISIONS violating sections on its
  // own authority, before the reader had seen either the violation or the
  // words it replaced. It now marks instead: the critique names the sections
  // at fault, cites the rules, and quotes the passages, and the reader decides
  // what to act on. Quoting the passage is what makes disagreeing with the
  // finding possible, and the old loop had already spent that disagreement.
  //
  // The critique arrives as a critique_record CALL, refused and asked again
  // through the tool-result path the section loop already uses and bounded by
  // the same MAX_TOOL_HANDSHAKES: a quote the model did not read off the
  // section verbatim is sent back with the fault named, and so is a citation
  // of a rule number the list does not carry. A model that answers in prose
  // anyway is not a failed pass — its VERDICT lines still become findings,
  // without spans, exactly as they always did.
  //
  // A failed or stopped review never fails the completed generation.
  private async runReviewPass(
    conversation: RawConversation,
    document: ProjectedDocument,
    writesByTool: boolean,
    abortSignal?: AbortSignal
  ): Promise<ReviewPassResult> {
    const conversationId = conversation.id
    const outline = document.outline!
    // Every span is measured against the body the reader is looking at, and
    // the replacement count is recorded beside it so a later reader can tell a
    // passage that was rewritten from one that was never there.
    const bodies = new Map<string, CritiqueSectionBody>(
      document.sections.map(section => [
        section.title,
        { body: section.content, revisions: sectionRevisions(section) }
      ])
    )

    try {
      this.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'reviewing',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length
      })

      // Clear the last section's title from progress so the streaming
      // critique text is not mistaken for live section content
      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      const critique = await this.requestCritique({
        conversationId,
        requestSectionTitle: STYLE_REVIEW_SECTION_TITLE,
        prompt: buildStyleCritiquePrompt(document.fullContent),
        stage: 'style',
        bodies,
        writesByTool,
        abortSignal,
        // The older line-oriented verdicts are still read, so a model that
        // cannot call tools — and the mock provider — still produce a usable
        // pass. What they cannot produce is a SPAN: a VERDICT line names a
        // section and a rule and points at no passage, and inventing one here
        // would be indistinguishable from a quote actually read off the body.
        // The weaker record is the honest one.
        fromProse: text => {
          const findings = findingsFromVerdicts(
            parseCritiqueResponse(text),
            outline.sections.map(section => section.title)
          )
          return { stage: 'style', verdict: findings.length === 0 ? 'pass' : 'revise', findings }
        }
      })

      return { ran: true, marked: reviewRevisionsFromFindings(critique.findings), critique }
    } catch (error) {
      // A user abort must still end the whole run, exactly as it does in
      // runOutlineCritique next door. Swallowing it here returns to a caller
      // that goes on to dispatch 'complete' and an isComplete progress for a
      // run the user stopped — the one failure a review must not report as
      // success. An ordinary review FAILURE is still swallowed: a review that
      // errors leaves a usable script, which is the whole point of the arm.
      // And the same record-gate discipline as the outline critique next door:
      // a style pass that stored nothing at all would be re-planned on every
      // later resume of a script it had already judged.
      this.closeOpenGeneration(conversationId, 'No style review was written')

      if (abortSignal?.aborted) throw error

      console.warn('Style review pass failed; keeping the generated script as-is', error)
      return { ran: false, marked: [] }
    }
  }

  // One judging request, from the first turn to the recorded critique.
  //
  // Shared by every pass that judges written prose — the style pass and the
  // reader's whole-script review — because a second acceptance path is exactly
  // how two passes come to disagree about what a critique may claim. What
  // differs between them is the question asked, the stage recorded and what
  // their older prose format means; the handshake, the refusals and the record
  // are one piece of code.
  //
  // Returns the critique that was RECORDED, on the generation as well as to
  // the caller; throws when the model never managed to record one, which is
  // the caller's cue to leave the script as it stands.
  private async requestCritique(args: {
    conversationId: string
    // The RegenerationRequest section title this pass is recognised by
    requestSectionTitle: string
    prompt: string
    stage: CritiqueStage
    bodies: ReadonlyMap<string, CritiqueSectionBody>
    writesByTool: boolean
    // What this pass's older line-oriented reply means, for a model that
    // cannot call tools. It quotes nothing, and nothing here invents a quote
    // for it.
    fromProse: (text: string) => CritiqueRecord
    abortSignal?: AbortSignal
  }): Promise<CritiqueRecord> {
    const { conversationId, abortSignal } = args
    const critiquePrompt = args.prompt
    const critiqueMessages: ChatMessage[] = [{ role: 'user', content: critiquePrompt }]
    let toolTurns: ProviderTurn[] = []

    for (let turn = 0; turn <= MAX_TOOL_HANDSHAKES; turn++) {
      if (abortSignal?.aborted) throw new Error('Generation aborted')

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: critiqueMessages
      })

      const critiqueStream = this.services.scriptService.regenerateSection(
        { prompt: critiquePrompt, conversationId, sectionTitle: args.requestSectionTitle },
        critiqueMessages,
        abortSignal,
        args.writesByTool ? { tools: WRITING_TOOLS, toolTurns } : undefined
      )

      const response = await this.streamResponse(
        critiqueStream,
        conversationId,
        abortSignal,
        streamed => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: streamed.text
          })
        }
      )

      const call = response.calls.find(entry => entry.name === CRITIQUE_RECORD_TOOL)

      if (call && response.finishedCleanly) {
        const outcome = this.acceptCritiqueCall(conversationId, args.bodies, call, args.stage)
        if (outcome.ok) return outcome.critique

        // Refused, and asked again with the tools still attached — the same
        // handshake a section of the wrong length gets. Nothing about the
        // refused critique is stored: a finding that could not be pinned is
        // not a finding, and half-recording it is what the whole design is
        // against.
        toolTurns = [
          {
            role: 'assistant',
            toolCalls: [{ id: call.id, name: CRITIQUE_RECORD_TOOL, arguments: call.arguments }]
          },
          { role: 'tool', toolCallId: call.id, content: outcome.reason }
        ]
        continue
      }

      const stray = namedCallOf(response)
      if (stray && stray.name !== CRITIQUE_RECORD_TOOL) {
        const answer = stray.name === GROUNDING_SELECT_TOOL
          ? answerGroundingSelect({ done: true, examples: [] }, CRITIQUE_RECORD_TOOL)
          : answerWrongTool(
              stray.name as string,
              CRITIQUE_RECORD_TOOL,
              'This pass judges the script; it does not write it.'
            )

        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: answer.record,
          toolCalls: [{
            id: stray.id,
            name: stray.name as WritingToolName,
            status: answer.status,
            reason: answer.content
          }]
        })
        this.persistConversation(conversationId)

        toolTurns = [
          {
            role: 'assistant',
            toolCalls: [{ id: stray.id, name: stray.name as string, arguments: stray.arguments }]
          },
          { role: 'tool', toolCallId: stray.id, content: answer.content }
        ]
        continue
      }

      if (call && !response.finishedCleanly) {
        // A critique cut off mid-arguments is not a critique: its findings
        // list may be missing the entries that never arrived, and a verdict
        // read off a fragment would claim the pass judged what it never saw.
        const reason =
          `REFUSED: the ${CRITIQUE_RECORD_TOOL} call did not finish ` +
          `(${response.finishReason ?? 'the stream ended without a finish reason'}), so the ` +
          'critique arrived incomplete. Record the whole critique again.'
        this.dispatch({
          type: 'COMPLETE_GENERATION',
          metrics: this.takeTurnMetrics(conversationId),
          conversationId,
          response: `No critique was recorded: ${reason}`,
          toolCalls: [{ id: call.id, name: CRITIQUE_RECORD_TOOL, status: 'rejected', reason }]
        })
        this.persistConversation(conversationId)

        toolTurns = [
          {
            role: 'assistant',
            toolCalls: [{ id: call.id, name: CRITIQUE_RECORD_TOOL, arguments: call.arguments }]
          },
          { role: 'tool', toolCallId: call.id, content: reason }
        ]
        continue
      }

      // Prose: whatever this pass's own older reply format means, read by
      // the caller that owns it. It carries no spans and none is invented
      // for it — see fromProse.
      //
      // A reply with nothing in it is still recorded as one non-empty line,
      // because a generation stored with an empty response is dropped
      // outright by the deployed parser, prompt block and all (D1).
      const critique = args.fromProse(response.text)

      // Read off the prose BEFORE the turn is closed, because the critique
      // is stored on the generation that closing action writes — a prose
      // pass records its verdict exactly as a tool call's does, minus the
      // spans it had no way to quote.
      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: response.text.trim() ? response.text : EMPTY_TURN_RECORD,
        critique
      })
      this.persistConversation(conversationId)

      return critique
    }

    throw new Error(`The model never recorded a ${CRITIQUE_RECORD_TOOL}`)
  }

  // One critique_record call, judged and stored. Accepting it closes the
  // generation with the critique read back as prose, so what the pass decided
  // is in the transcript and not only in the record; refusing it closes the
  // generation with the refusal, because a generation stored with an empty
  // response is dropped outright by the deployed parser and would take its
  // prompt block with it (D1).
  //
  // The accepted record is written ONTO the generation, by the same action
  // that closes it, because the generation is the only place a critique
  // survives: the serializer, the parser, the library importer and the
  // projection's findings fold all read it from there. Returning it to the
  // caller and no more would leave every finding alive for the length of one
  // call and gone from the reading view the moment the run ended.
  private acceptCritiqueCall(
    conversationId: string,
    bodies: ReadonlyMap<string, CritiqueSectionBody>,
    call: StreamedToolCall,
    // The stage of the pass actually running. The model names a stage in its
    // own arguments and that claim is not evidence: a style pass that calls
    // itself a review is recorded as a review, and the reading view then tells
    // the reader a finding came from a pass that never ran. The running pass
    // knows which it is, so a claim that disagrees is refused like any other.
    stage: CritiqueStage,
    // What the generation records as its response when the critique is
    // accepted. The style and review passes have nothing else to say, so they
    // leave it out and the critique read back as prose is the record. The
    // outline pass may have revised the plan in the same turn, and that plan
    // IS the record: every later consumer — resume, section writing,
    // regeneration — reads the latest outline out of a generation's response,
    // so a critique rendered over the top of it would lose the revision.
    acceptedResponse?: string,
    // Calls accepted in the same turn, recorded beside the critique's own. The
    // projection reads a tool-written generation through its CALLS, so a plan
    // re-issued alongside a critique has to be one of them or the revision is
    // invisible to everything downstream.
    acceptedAlongside?: GenerationToolCall[]
  ): { ok: true; critique: CritiqueRecord } | { ok: false; reason: string } {
    const args = parseCritiqueToolCall(call.arguments)
    if (!args) {
      const reason =
        `REFUSED: those ${CRITIQUE_RECORD_TOOL} arguments did not describe a critique. Call it ` +
        'again with a stage, a verdict of "pass" or "revise", and the findings.'
      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: `No critique was recorded: ${reason}`,
        toolCalls: [{ id: call.id, name: CRITIQUE_RECORD_TOOL, status: 'rejected', reason }]
      })
      this.persistConversation(conversationId)
      return { ok: false, reason }
    }

    if (args.stage !== stage) {
      const reason =
        `REFUSED: this is the ${stage} pass, but the call named stage "${args.stage}". ` +
        `Call ${CRITIQUE_RECORD_TOOL} again with stage "${stage}".`
      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: `No critique was recorded: ${reason}`,
        toolCalls: [{ id: call.id, name: CRITIQUE_RECORD_TOOL, status: 'rejected', reason }]
      })
      this.persistConversation(conversationId)
      return { ok: false, reason }
    }

    const accepted = acceptCritique(bodies, stage, args.verdict, args.findings)
    if (!accepted.ok) {
      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: `No critique was recorded: ${accepted.reason}`,
        toolCalls: [{
          id: call.id,
          name: CRITIQUE_RECORD_TOOL,
          status: 'rejected',
          reason: accepted.reason
        }]
      })
      this.persistConversation(conversationId)
      return { ok: false, reason: accepted.reason }
    }

    this.dispatch({
      type: 'COMPLETE_GENERATION',
      metrics: this.takeTurnMetrics(conversationId),
      conversationId,
      response: acceptedResponse ?? renderCritique(accepted.critique),
      critique: accepted.critique,
      toolCalls: [...(acceptedAlongside ?? []), {
        id: call.id,
        name: CRITIQUE_RECORD_TOOL,
        status: 'accepted' as const,
        // Named for the pass that is RUNNING, like every refusal above it: a
        // review's record that says "the style pass" tells the reader a pass
        // that never ran found this.
        reason: accepted.critique.verdict === 'pass'
          ? `The ${stage} pass approved the script.`
          : `The ${stage} pass marked ${accepted.critique.findings.length} section(s).`
      }]
    })
    this.persistConversation(conversationId)
    return { ok: true, critique: accepted.critique }
  }

  // On-demand whole-script review (story 8.14): judges the finished script as
  // one artifact — continuity and escalation across sections, setups paid off,
  // and the measured length against its spoken-duration target — and RECORDS
  // what it found. The script's current consolidated state is what gets
  // reviewed, so a review can follow manual edits, regenerations and
  // refinements.
  //
  // It rewrote up to three sections until now. It marks them instead, on the
  // same terms as the style pass and through the same tool and the same
  // acceptance rules: this pass CAN quote, because the script is written, so
  // it does — and a reader who can read the quoted passage can disagree with
  // the finding, which is exactly what a rewrite spends before they see it.
  // Pressing the button asks an editor what they think; it does not hand the
  // editor the pen. See scriptReview.ts for what went with the rewrites.
  async reviewScript(
    conversation: RawConversation,
    brief: string,
    targetMinutes?: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const plan = buildLengthPlan(targetMinutes)
    this.streamSaves = new StreamPersistence()

    // A COMMAND, not a planned round: the reader presses this button, and may
    // press it again. It stamps a round record all the same, so that a
    // pipeline which ever does switch the review on will not re-review a
    // script the reader has already reviewed by hand — the record the button
    // leaves satisfies that gate. The number continues the conversation's own
    // numbering, so nothing the planner counts from is fabricated.
    const rounds = projectConversation(conversation).rounds
    this.currentRound = {
      round: (rounds[rounds.length - 1]?.round ?? 0) + 1,
      kind: 'review'
    }

    try {
      // A fresh run owns generation state from here, and clears any previous
      // review report so the banner describes this pass
      this.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      const outline = getLatestOutline(conversation)
      if (!outline) {
        throw new Error('This script has no outline to review against')
      }

      const sections = consolidateSections(conversation)
      if (sections.length === 0) {
        throw new Error('This script has no sections to review')
      }

      const scriptContent = `# ${outline.title}` +
        sections.map(section => `\n\n## ${section.title}\n${section.content}`).join('')
      const assessment = assessScriptLength(sections, plan)

      this.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'reviewing',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length
      })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      // How this review is written, decided the way a run's mode is: the model
      // pinned on the script. A model that cannot call tools still answers in
      // the older VERDICT lines and its findings are recorded all the same.
      const writesByTool = planGeneration(
        this.callbacks.getScript?.(conversation.scriptId)
      ).mode === 'tools'

      // Every span is measured against the body the reader is looking at, and
      // the replacement count is recorded beside it, exactly as the style pass
      // does. The bodies come from the projection so a section rewritten since
      // it was written carries its revision count with it.
      const projected = projectConversation(conversation)
      const bodies = new Map<string, CritiqueSectionBody>(
        projected.sections.map(section => [
          section.title,
          { body: section.content, revisions: sectionRevisions(section) }
        ])
      )

      const critique = await this.requestCritique({
        conversationId,
        requestSectionTitle: SCRIPT_REVIEW_SECTION_TITLE,
        prompt: buildScriptReviewPrompt(brief, formatLengthBrief(assessment), scriptContent),
        stage: 'review',
        bodies,
        writesByTool,
        abortSignal,
        // The older line-oriented verdicts, for a model that cannot call
        // tools. They name sections and quote nothing, and nothing here
        // invents a quote for them.
        fromProse: text => {
          const findings = findingsFromReviewVerdicts(
            parseScriptReviewResponse(text),
            sections.map(section => section.title)
          )
          return { stage: 'review', verdict: findings.length === 0 ? 'pass' : 'revise', findings }
        }
      })

      const marked = reviewRevisionsFromFindings(critique.findings)

      // The script the review judged is the script the reader still has:
      // nothing was rewritten, so what is saved and what is reported are
      // measured off the very sections the findings quote.
      this.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'complete',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length,
        sectionWordCounts: assessment.sections.map(section => section.wordCount)
      })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: {
          status: 'complete',
          title: outline.title,
          content: scriptContent,
          length: formatScriptLength(assessment.totalWords)
        }
      })

      this.dispatch({
        type: 'REVIEW_PASS_COMPLETED',
        report: {
          conversationId,
          revised: marked,
          summary: formatScriptReviewSummary(marked, assessment),
          structure: sections.map(section => section.title)
        }
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // Whether stopped or failed, the script itself is untouched apart from
      // any sections already revised, so settle without an error phase: a
      // failed review is reported next to its own button, not as a failed
      // generation
      this.closeOpenGeneration(conversationId, 'No script review was written')

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.persistConversation(conversationId)

      if (abortSignal?.aborted) return

      console.error('Style review error:', error)
      throw error
    } finally {
      this.currentRound = undefined
    }
  }

  async regenerateSection(
    request: RegenerationRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    this.streamSaves = new StreamPersistence()

    // Reached as a COMMAND — the reader's own regenerate button — this stamps
    // NO round: a section's gate is an artifact gate, so a record would be
    // inert, and a record carrying a made-up round number would corrupt the
    // numbering the planner counts from.
    //
    // Reached from INSIDE a round — the style pass and the whole-script review
    // both rewrite sections through here — it stamps the enclosing round's
    // NUMBER with kind 'section', because a rewrite is the work this
    // generation is, whatever round enclosed it. Inheriting the enclosing
    // 'style-critique' or 'review' kind instead made every fold that skips
    // critique prose skip these rewrites too, so the reading view and the
    // saved script never showed the revisions the pass had just paid for.
    const round: GenerationRound | undefined = this.currentRound
      ? { round: this.currentRound.round, kind: 'section' }
      : undefined

    try {
      // A fresh regeneration run owns generation state from here; without this
      // a previously completed run's state would swallow the progress updates
      this.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false,
        sectionTitle: request.sectionTitle
      })

      // Build complete conversation history from all generations, normalised
      // to a single system message (story 8.13)
      const messages = buildConversationHistory(conversation, request.prompt)

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages,
        round
      })

      this.persistConversation(conversationId)

      const plan = buildLengthPlan(request.targetMinutes)
      const examples = await this.examplesFor(
        conversationId,
        request.brief?.trim() || request.prompt,
        plan,
        conversation
      )

      // The rewrite sees where this section sits in the whole script, and the
      // same exemplars the system prompt carries, mounted under /examples/ so
      // both blocks name them the same way. Added at send time only, after
      // START_GENERATION has stored the history, so the tree is never replayed
      // from a later request's history.
      const stream = this.services.scriptService.regenerateSection(
        request,
        withGenerationSystemPrompt(
          withStructureBlock(messages, buildScriptFs(conversation, examples)),
          buildGenerationSystemPrompt(plan, examples)
        ),
        abortSignal
      )

      const sectionText = await this.streamToString(
        stream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: ensureSectionHeading(request.sectionTitle, accumulated)
          })
        }
      )

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        sectionTitle: request.sectionTitle
      })

      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: ensureSectionHeading(request.sectionTitle, sectionText)
      })

      this.persistConversation(conversationId)

    } catch (error) {
      this.closeOpenGeneration(
        conversationId,
        `No section was written for "${request.sectionTitle}"`
      )

      // The user stopped the regeneration: keep what streamed in and settle
      // quietly instead of surfacing an error banner
      if (abortSignal?.aborted) {
        this.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true,
          sectionTitle: request.sectionTitle
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Section regeneration error:', error)

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    }
  }

  // Whole-script refinement: sends the full conversation history plus the
  // user's instruction; the model replies with ONLY the changed sections in
  // "## Section" format, stored as a new generation so consolidation-by-title
  // replaces them in the document
  async refineScript(
    request: RefinementRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    this.streamSaves = new StreamPersistence()

    // A command as well, stamping no round, for the same reason
    try {
      // A fresh refinement run owns generation state from here
      this.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      // Build complete conversation history from all generations, normalised
      // to a single system message (story 8.13)
      const messages = buildConversationHistory(conversation, request.prompt)

      this.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages
      })

      this.persistConversation(conversationId)

      const plan = buildLengthPlan(request.targetMinutes)
      const examples = await this.examplesFor(
        conversationId,
        request.brief?.trim() || request.prompt,
        plan,
        conversation
      )

      // A whole-script refinement decides which sections to rewrite, so it is
      // told what the sections currently are, and which exemplars it has to
      // work from. Send-time only, as above.
      const stream = this.services.scriptService.regenerateSection(
        { prompt: request.prompt, conversationId, sectionTitle: '' },
        withGenerationSystemPrompt(
          withStructureBlock(messages, buildScriptFs(conversation, examples)),
          buildGenerationSystemPrompt(plan, examples)
        ),
        abortSignal
      )

      const responseText = await this.streamToString(
        stream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.dispatch({
        type: 'COMPLETE_GENERATION',
        metrics: this.takeTurnMetrics(conversationId),
        conversationId,
        response: responseText
      })

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.persistConversation(conversationId)

    } catch (error) {
      this.closeOpenGeneration(conversationId, 'No refinement was written')

      // The user stopped the refinement: keep what streamed in
      if (abortSignal?.aborted) {
        this.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Script refinement error:', error)

      this.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    }
  }
}
