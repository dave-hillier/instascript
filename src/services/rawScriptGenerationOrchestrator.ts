import type { RawConversation, GenerationRequest, RegenerationRequest, RefinementRequest, ChatMessage, ReviewRevision, ScriptOutline } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversationAction } from '../reducers/rawConversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt, getOutlineGenerationPrompt, getSectionGenerationPrompt, buildStyleCritiquePrompt, buildOutlineCritiquePrompt, buildScriptReviewPrompt, buildSectionRegenerationPromptFromConversation, buildConversationHistory, buildGenerationSystemPrompt, withGenerationSystemPrompt, withStructureBlock } from './prompts'
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
import { parseCritiqueResponse, selectViolationsToRevise, buildRevisionInstruction, STYLE_REVIEW_SECTION_TITLE } from './critiquePass'
import { parseOutlineCritiqueResponse, OUTLINE_CRITIQUE_SECTION_TITLE } from './outlineCritique'
import { buildLengthPlan } from './scriptLength'
import type { LengthPlan } from './scriptLength'
import { assessScriptLength, formatLengthBrief, parseScriptReviewResponse, selectScriptRevisions, buildScriptRevisionInstruction, describeRevisionReason, formatScriptReviewSummary, SCRIPT_REVIEW_SECTION_TITLE } from './scriptReview'
import { KeyedRunGuard } from './runLifecycle'
import { recordExampleSelections } from './exampleCorpus'
import { isTextFrame, isToolCallFrame } from './providerFrame'
import type { ProviderFrame } from './providerFrame'
import { scanPartialJsonObject } from './partialJson'
import { WRITING_TOOLS, GROUNDING_SELECT_TOOL, OUTLINE_WRITE_TOOL, SECTION_WRITE_TOOL } from './writingTools'
// The one rule for "this generation contributed nothing to the script", shared
// with the projection, the replayed history and the activity thread: four
// readers have to agree on it, so there is one copy of it
import { isRejectedGeneration } from './scriptProjection'
import type { WritingToolName } from './writingTools'
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
  revised: ReviewRevision[]
  // The consolidated script including revised sections, when any were revised
  updatedContent?: string
}

interface ResumeState {
  outline: ScriptOutline
  outlineText: string
  sectionTexts: Map<string, string>
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
  calls: StreamedToolCall[]
  finishReason: string | null
  // D6: a call may only be ACCEPTED after a clean finish. An abort landing
  // exactly at the end of a call's arguments leaves them parseable, and a
  // `length` finish means the provider cut the model off mid-body — in both
  // cases the JSON can look complete while the section is not.
  finishedCleanly: boolean
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

// Inspect an existing conversation for a usable outline and already-generated
// sections, so an interrupted or failed run can pick up where it left off
// instead of starting over. Exported for unit testing.
export function findResumeState(conversation: RawConversation): ResumeState | null {
  let outline: ScriptOutline | null = null
  let outlineText = ''
  let outlineIndex = -1

  for (let i = 0; i < conversation.generations.length; i++) {
    // Defensive rather than load-bearing, unlike its counterpart in the section
    // scan below: no shape a rejected generation is stored in can satisfy
    // parseOutline today — a refused outline call and every handshake store a
    // one-line record, and a refused section stores "## Title", which has no
    // document heading to match. Kept so both scans answer to the same rule, so
    // that a future refusal that does render an outline cannot resurrect one.
    if (isRejectedGeneration(conversation.generations[i])) continue
    const parsed = parseOutline(conversation.generations[i].response)
    if (parsed) {
      outline = parsed
      outlineText = conversation.generations[i].response
      outlineIndex = i
    }
  }

  if (!outline) return null

  // An outline that is the conversation's last generation may itself be
  // truncated (interrupted mid-stream) even though it parses — a shortened
  // plan would silently produce a shorter script. Only trust an outline the
  // run demonstrably moved past: section generation starts a new entry, so a
  // later generation proves the outline finished streaming.
  if (outlineIndex === conversation.generations.length - 1) return null

  const sectionTexts = new Map<string, string>()
  for (let i = outlineIndex + 1; i < conversation.generations.length; i++) {
    // A rejected attempt is stored with its body so nothing is silently lost,
    // but a resume must not restore a section the run itself refused
    if (isRejectedGeneration(conversation.generations[i])) continue
    const match = conversation.generations[i].response.match(/^##\s+(.+?)\s*\n([\s\S]*)$/)
    if (match && match[2].trim()) {
      sectionTexts.set(match[1].trim(), match[2].trim())
    }
  }

  return { outline, outlineText, sectionTexts }
}

export class RawScriptGenerationOrchestrator {
  private services: RawScriptServices
  private callbacks: RawGenerationCallbacks
  private options: RawGenerationOptions
  private activeGenerations = new KeyedRunGuard()
  private lastSaveTime = 0
  private saveThrottleMs = 1000
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

    for await (const frame of stream) {
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
      const now = Date.now()
      if (now - this.lastSaveTime > this.saveThrottleMs) {
        this.persistConversation(conversationId)
        this.lastSaveTime = now
      }
    }

    return accumulated
  }

  // The tool-path counterpart of streamToString. It keeps everything the
  // stream carries rather than only the prose: a run written by tool call needs
  // the arguments, the finish reason and the text a model that ignored the
  // tools replied with, and has to decide between them once the stream ends.
  //
  // `onProgress` is called on every text or tool-call frame with the response
  // as it stands, so a caller can render a body that is still arriving.
  private async streamResponse(
    stream: AsyncIterable<ProviderFrame>,
    conversationId: string,
    abortSignal?: AbortSignal,
    onProgress?: (response: StreamedResponse) => void
  ): Promise<StreamedResponse> {
    const calls = new Map<number, StreamedToolCall>()
    let text = ''
    let finishReason: string | null = null
    let finishedCleanly = false

    const snapshot = (): StreamedResponse => ({
      text,
      calls: [...calls.values()].sort((a, b) => a.index - b.index),
      finishReason,
      finishedCleanly
    })

    for await (const frame of stream) {
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
      } else {
        continue
      }

      onProgress?.(snapshot())

      const now = Date.now()
      if (now - this.lastSaveTime > this.saveThrottleMs) {
        this.persistConversation(conversationId)
        this.lastSaveTime = now
      }
    }

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
      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: `${subject}: the request ended before the model finished.`
      })
      this.persistConversation(conversationId)
      throw error
    }
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

      this.callbacks.dispatch({
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
            this.callbacks.dispatch({
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
          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
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
        // is dropped by the deployed parser, taking its prompt with it (D1), so
        // what happened is recorded in one non-empty line before the run fails.
        const reason = response.finishedCleanly
          ? `REJECTED: those ${OUTLINE_WRITE_TOOL} arguments did not describe a usable plan.`
          : `REJECTED: the ${OUTLINE_WRITE_TOOL} call did not finish ` +
            `(${response.finishReason ?? 'the stream ended without a finish reason'}).`
        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
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
          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
            conversationId,
            response: `No outline was written: ${reason}.`
          })
          this.persistConversation(conversationId)
          throw new Error('Failed to parse outline from LLM response')
        }

        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
          conversationId,
          response: response.text
        })
        return response.text
      }

      const answer = stray.name === GROUNDING_SELECT_TOOL
        ? answerGroundingSelect(args.grounding, OUTLINE_WRITE_TOOL)
        : answerWrongTool(stray.name as string, OUTLINE_WRITE_TOOL, 'The outline is not written yet.')
      if (stray.name === GROUNDING_SELECT_TOOL) args.grounding.done = true

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
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
    this.callbacks.dispatch({
      type: 'START_GENERATION',
      conversationId: args.conversationId,
      messages: args.messages
    })

    this.callbacks.dispatch({
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
        this.callbacks.dispatch({
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
          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
            conversationId,
            response: `No section was written for "${sectionTitle}": the reply was cut off (${reason}).`
          })
          this.persistConversation(conversationId)
          throw new Error(
            `The section "${sectionTitle}" was never written: the reply was cut off (${reason})`
          )
        }

        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
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

        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
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

        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
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
        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
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
          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
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
        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
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

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        // Stored with its body even though the projection folds it out: a
        // rejected draft is evidence of what the run did, and a generation
        // written with an empty response is DROPPED by the already-deployed
        // parser, taking its prompt with it (D1).
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
    const generationKey = `${conversationId}-initial`
    // The requested length shapes the system prompt, the outline's section
    // count and the length the finished script is judged against
    const plan = buildLengthPlan(request.targetMinutes)

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh run (first attempt, retry or resume) owns generation state from here
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })
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
      const runPlan = planGeneration(this.callbacks.getScript?.(conversation.scriptId))
      const writesByTool = runPlan.mode === 'tools'
      // The rejection budget belongs to the run, not to a section: a model
      // systematically writing long would otherwise pay the per-section cap
      // over and over, once for every section of the script.
      const rejectionBudget = { remaining: SECTION_REJECTION_BUDGET }

      // Retrieve examples upfront; record which ones inform this generation
      const examples = await this.retrieveExamples(request, conversation, plan)
      // The corpus the run is grounded in, and whether the model has already
      // asked for it. The retrieval happened here, before the first request, so
      // a grounding_select call is answered from what the run already has
      // rather than searching again on the model's say-so.
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

      // An explicit fresh restart (story 1.8) discards the previous outline
      // and sections so nothing from the abandoned plan survives consolidation
      if (request.fresh && conversation.generations.length > 0) {
        this.callbacks.dispatch({ type: 'GENERATIONS_DISCARDED', conversationId })
        this.callbacks.saveConversation({
          ...conversation,
          generations: [],
          updatedAt: Date.now()
        })
      }

      // Reuse an existing outline and completed sections when retrying/resuming
      const resume = request.fresh ? null : findResumeState(conversation)
      let outline: ScriptOutline
      let outlineText: string

      if (resume) {
        outline = resume.outline
        outlineText = resume.outlineText
      } else {
        // --- Phase 1: Generate outline ---
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'generating_outline',
          currentSectionIndex: 0,
          totalSections: 0,
          sectionWordCounts: []
        })

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: false
        })

        const outlineUserPrompt = request.prompt + '\n\n' + (writesByTool
          ? getToolOutlineGenerationPrompt(plan)
          : getOutlineGenerationPrompt(plan))
        const outlineMessages: ChatMessage[] = [
          { role: 'system', content: storedSystemPrompt },
          { role: 'user', content: outlineUserPrompt }
        ]

        if (writesByTool) {
          outlineText = await this.writeOutlineWithTools({
            conversationId,
            request,
            outlineUserPrompt,
            outlineMessages,
            exampleIds,
            examples,
            systemPrompt,
            grounding,
            abortSignal
          })
        } else {
          // Start a generation entry for the outline
          this.callbacks.dispatch({
            type: 'START_GENERATION',
            conversationId,
            messages: outlineMessages,
            exampleIds: exampleIds.length > 0 ? exampleIds : undefined
          })

          const outlineStream = this.services.scriptService.generateScript(
            { ...request, prompt: outlineUserPrompt },
            withGenerationSystemPrompt(outlineMessages, systemPrompt),
            examples,
            abortSignal
          )

          outlineText = await this.streamToString(
            outlineStream,
            conversationId,
            abortSignal,
            (accumulated) => {
              this.callbacks.dispatch({
                type: 'UPDATE_CURRENT_GENERATION',
                conversationId,
                response: accumulated
              })
            }
          )

          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
            conversationId,
            response: outlineText
          })
        }

        this.persistConversation(conversationId)

        // Parse the outline
        const parsedOutline = parseOutline(outlineText)
        if (!parsedOutline) {
          throw new Error('Failed to parse outline from LLM response')
        }
        outline = parsedOutline

        // --- Phase 1.5: optional outline critique (story 8.9) ---
        // Checked against the brief before any section is written; a revised
        // outline supersedes the original as the plan every section inherits.
        // Gated by the same setting as the style-review pass.
        if (this.options.reviewPassEnabled) {
          const critiqued = await this.runOutlineCritique(
            conversationId,
            request,
            plan,
            outline,
            outlineText,
            abortSignal
          )
          outline = critiqued.outline
          outlineText = critiqued.outlineText
        }
      }

      if (abortSignal?.aborted) throw new Error('Generation aborted')

      // --- Phase 2: Generate sections one at a time ---
      const sectionWordCounts: number[] = []
      let scriptContent = `# ${outline.title}`
      let startIndex = 0

      if (resume) {
        // Keep fully generated sections; redo the last present one since it may
        // have been cut off mid-stream, then continue with the missing ones
        let firstMissing = outline.sections.findIndex(
          section => !resume.sectionTexts.has(section.title)
        )
        if (firstMissing === -1) firstMissing = outline.sections.length
        startIndex = Math.max(0, firstMissing - 1)

        for (let i = 0; i < startIndex; i++) {
          const section = outline.sections[i]
          const text = resume.sectionTexts.get(section.title) ?? ''
          sectionWordCounts.push(countWords(text))
          scriptContent += `\n\n## ${section.title}\n${text}`
        }
      }

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'generating_section',
        outline,
        currentSectionIndex: startIndex,
        totalSections: outline.sections.length,
        sectionWordCounts: [...sectionWordCounts]
      })

      for (let i = startIndex; i < outline.sections.length; i++) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        const section = outline.sections[i]

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'generating_section',
          outline,
          currentSectionIndex: i,
          totalSections: outline.sections.length,
          sectionWordCounts: [...sectionWordCounts]
        })

        // Upcoming outline entries let this section plant setups (story 8.10)
        const sectionPrompt = writesByTool
          ? getToolSectionGenerationPrompt(
              section.title,
              section.description,
              outline.sections.slice(i + 1)
            )
          : getSectionGenerationPrompt(
              section.title,
              section.description,
              outline.sections.slice(i + 1)
            )
        const sectionUserMessage = `Here is the outline for the full script:\n\n${outlineText}\n\nHere is what has been written so far:\n\n${scriptContent}\n\n${sectionPrompt}`

        const runSectionAttempt = async (userMessage: string): Promise<string> => {
          const sectionMessages: ChatMessage[] = [
            { role: 'system', content: storedSystemPrompt },
            { role: 'user', content: request.prompt },
            { role: 'assistant', content: outlineText },
            { role: 'user', content: userMessage }
          ]

          this.callbacks.dispatch({
            type: 'START_GENERATION',
            conversationId,
            messages: sectionMessages
          })

          this.callbacks.dispatch({
            type: 'SET_GENERATION_PROGRESS',
            conversationId,
            isComplete: false,
            sectionTitle: section.title
          })

          const sectionStream = this.services.scriptService.regenerateSection(
            { prompt: userMessage, conversationId, sectionTitle: section.title },
            withGenerationSystemPrompt(sectionMessages, systemPrompt),
            abortSignal
          )

          const text = await this.streamToString(
            sectionStream,
            conversationId,
            abortSignal,
            (accumulated) => {
              this.callbacks.dispatch({
                type: 'UPDATE_CURRENT_GENERATION',
                conversationId,
                response: ensureSectionHeading(section.title, accumulated)
              })
            }
          )

          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
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
        const written = writesByTool
          ? await this.writeSectionWithTools({
              conversationId,
              sectionTitle: section.title,
              userMessage: sectionUserMessage,
              storedSystemPrompt,
              systemPrompt,
              history: [
                { role: 'user', content: request.prompt },
                { role: 'assistant', content: outlineText }
              ],
              budget: rejectionBudget,
              grounding,
              abortSignal
            })
          : null

        let sectionText = written
          ? (written.kind === 'written' ? written.body : written.text)
          : await runSectionAttempt(sectionUserMessage)
        let wordCount = countWords(sectionText)

        // A section well outside the word target gets one corrective retry;
        // the attempt closer to the target is kept
        if (written?.kind !== 'written' && shouldRetrySection(wordCount)) {
          this.persistConversation(conversationId)

          const retryText = await runSectionAttempt(
            `${sectionUserMessage}\n\n${buildRetryNote(wordCount)}`
          )

          sectionText = pickBetterSectionText(sectionText, retryText)
          wordCount = countWords(sectionText)

          if (sectionText !== retryText) {
            // The first attempt won: overwrite the retry generation's stored
            // response so consolidation-by-title lands on the kept text
            this.callbacks.dispatch({
              type: 'COMPLETE_GENERATION',
              conversationId,
              response: ensureSectionHeading(section.title, sectionText)
            })
          }
        }

        sectionWordCounts.push(wordCount)

        scriptContent += '\n\n' + ensureSectionHeading(section.title, sectionText)

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'generating_section',
          outline,
          currentSectionIndex: i + 1,
          totalSections: outline.sections.length,
          sectionWordCounts: [...sectionWordCounts]
        })

        this.persistConversation(conversationId)
      }

      // An abort can land on a section's last request and still leave the loop
      // ending naturally, and the review pass swallows the abort it then sees —
      // so without this check a stopped run would be dispatched 'complete'. The
      // loop head and the Phase 1 boundaries check the same signal; this is the
      // one boundary that was missing.
      if (abortSignal?.aborted) throw new Error('Generation aborted')

      // --- Phase 2.5: optional style-review pass (story 8.5) ---
      let reviewResult: ReviewPassResult | null = null
      if (this.options.reviewPassEnabled) {
        reviewResult = await this.runReviewPass(
          conversation,
          outline,
          scriptContent,
          request.targetMinutes,
          abortSignal
        )
        if (reviewResult.updatedContent) {
          scriptContent = reviewResult.updatedContent
        }
      }

      // --- Phase 3: Complete ---
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'complete',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length,
        sectionWordCounts
      })

      this.callbacks.dispatch({
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
        this.callbacks.dispatch({
          type: 'REVIEW_PASS_COMPLETED',
          report: {
            conversationId,
            revised: reviewResult.revised,
            // The sections as reviewed, so the summary retires itself once the
            // script is restructured under it
            structure: parseMarkdownSections(scriptContent).map(section => section.title)
          }
        })
      }

      this.persistConversation(conversationId)

    } catch (error) {
      // The user stopped the generation: keep what streamed in and settle as a draft
      if (abortSignal?.aborted) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'idle'
        })

        this.callbacks.dispatch({
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

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      this.callbacks.dispatch({
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
      this.activeGenerations.finish(generationKey)
    }
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
    abortSignal?: AbortSignal
  ): Promise<{ outline: ScriptOutline; outlineText: string }> {
    try {
      const critiquePrompt = buildOutlineCritiquePrompt(request.prompt, outlineText, plan)
      const critiqueMessages: ChatMessage[] = [{ role: 'user', content: critiquePrompt }]

      this.callbacks.dispatch({
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
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      const result = parseOutlineCritiqueResponse(critiqueText)

      // A revision is stored as exactly the outline text, so latest-outline-
      // wins consumers (resume, regeneration) see it supersede generation 0
      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: result.revisedOutlineText ?? critiqueText
      })

      this.persistConversation(conversationId)

      if (result.revisedOutline && result.revisedOutlineText) {
        return { outline: result.revisedOutline, outlineText: result.revisedOutlineText }
      }
      return { outline, outlineText }
    } catch (error) {
      // A user abort must still end the whole run
      if (abortSignal?.aborted) throw error

      console.warn('Outline critique failed; keeping the generated outline as-is', error)
      return { outline, outlineText }
    }
  }

  // Style-review pass (story 8.5): one critique request checks the finished
  // script against the style rules, then up to MAX_REVIEW_REVISIONS violating
  // sections are regenerated once each through the ordinary
  // section-regeneration path with the violation as the instruction. A
  // failed or stopped review never fails the completed generation.
  private async runReviewPass(
    conversation: RawConversation,
    outline: ScriptOutline,
    scriptContent: string,
    targetMinutes?: number,
    abortSignal?: AbortSignal
  ): Promise<ReviewPassResult> {
    const conversationId = conversation.id
    const revised: ReviewRevision[] = []

    try {
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'reviewing',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length
      })

      // Clear the last section's title from progress so the streaming
      // critique text is not mistaken for live section content
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      const critiquePrompt = buildStyleCritiquePrompt(scriptContent)
      const critiqueMessages: ChatMessage[] = [{ role: 'user', content: critiquePrompt }]

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: critiqueMessages
      })

      const critiqueStream = this.services.scriptService.regenerateSection(
        { prompt: critiquePrompt, conversationId, sectionTitle: STYLE_REVIEW_SECTION_TITLE },
        critiqueMessages,
        abortSignal
      )

      const critiqueText = await this.streamToString(
        critiqueStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: critiqueText
      })

      this.persistConversation(conversationId)

      const verdicts = parseCritiqueResponse(critiqueText)
      const violations = selectViolationsToRevise(
        verdicts,
        outline.sections.map(section => section.title)
      )

      for (const violation of violations) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        const current = this.callbacks.getConversation(conversationId) ?? conversation
        const prompt = buildSectionRegenerationPromptFromConversation(
          current,
          violation.sectionTitle,
          buildRevisionInstruction(violation)
        )

        await this.regenerateSection(
          { prompt, conversationId, sectionTitle: violation.sectionTitle, targetMinutes },
          current,
          abortSignal
        )

        revised.push({
          sectionTitle: violation.sectionTitle,
          ruleNumbers: violation.ruleNumbers
        })
      }

      const updated = this.callbacks.getConversation(conversationId)
      const updatedContent = updated && revised.length > 0
        ? `# ${outline.title}` +
          consolidateSections(updated)
            .map(section => `\n\n## ${section.title}\n${section.content}`)
            .join('')
        : undefined

      return { ran: true, revised, updatedContent }
    } catch (error) {
      // A user abort must still end the whole run, exactly as it does in
      // runOutlineCritique next door. Swallowing it here returns to a caller
      // that goes on to dispatch 'complete' and an isComplete progress for a
      // run the user stopped — the one failure a review must not report as
      // success. An ordinary review FAILURE is still swallowed: a review that
      // errors leaves a usable script, which is the whole point of the arm.
      if (abortSignal?.aborted) throw error

      console.warn('Style review pass failed; keeping the generated script as-is', error)
      return { ran: false, revised }
    }
  }

  // On-demand whole-script review (story 8.14): judges the finished script as
  // one artifact — continuity and escalation across sections, setups paid off,
  // and the measured length against its spoken-duration target — then rewrites
  // the sections that need it through the ordinary section-regeneration path.
  // The script's current consolidated state is what gets reviewed, so a review
  // can follow manual edits, regenerations and refinements.
  async reviewScript(
    conversation: RawConversation,
    brief: string,
    targetMinutes?: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const generationKey = `${conversationId}-review`
    const plan = buildLengthPlan(targetMinutes)

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh run owns generation state from here, and clears any previous
      // review report so the banner describes this pass
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

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

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'reviewing',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      const reviewPrompt = buildScriptReviewPrompt(
        brief,
        formatLengthBrief(assessment),
        scriptContent
      )
      const reviewMessages: ChatMessage[] = [{ role: 'user', content: reviewPrompt }]

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: reviewMessages
      })

      const reviewStream = this.services.scriptService.regenerateSection(
        { prompt: reviewPrompt, conversationId, sectionTitle: SCRIPT_REVIEW_SECTION_TITLE },
        reviewMessages,
        abortSignal
      )

      const reviewText = await this.streamToString(
        reviewStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: reviewText
      })

      this.persistConversation(conversationId)

      const revisions = selectScriptRevisions(
        parseScriptReviewResponse(reviewText),
        sections,
        assessment
      )

      const revised: ReviewRevision[] = []
      for (const revision of revisions) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        const current = this.callbacks.getConversation(conversationId) ?? conversation
        const prompt = buildSectionRegenerationPromptFromConversation(
          current,
          revision.sectionTitle,
          buildScriptRevisionInstruction(revision, plan)
        )

        await this.regenerateSection(
          { prompt, conversationId, sectionTitle: revision.sectionTitle, targetMinutes },
          current,
          abortSignal
        )

        revised.push({
          sectionTitle: revision.sectionTitle,
          reason: describeRevisionReason(revision)
        })
      }

      const finalSections = revised.length > 0
        ? consolidateSections(this.callbacks.getConversation(conversationId) ?? conversation)
        : sections
      const finalContent = `# ${outline.title}` +
        finalSections.map(section => `\n\n## ${section.title}\n${section.content}`).join('')
      // Reported against the script as it now stands, so the summary states
      // the length the user actually has
      const finalAssessment = assessScriptLength(finalSections, plan)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'complete',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length,
        sectionWordCounts: finalAssessment.sections.map(section => section.wordCount)
      })

      this.callbacks.dispatch({
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
          content: finalContent,
          length: formatScriptLength(finalAssessment.totalWords)
        }
      })

      this.callbacks.dispatch({
        type: 'REVIEW_PASS_COMPLETED',
        report: {
          conversationId,
          revised,
          summary: formatScriptReviewSummary(revised, finalAssessment),
          structure: finalSections.map(section => section.title)
        }
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // Whether stopped or failed, the script itself is untouched apart from
      // any sections already revised, so settle without an error phase: a
      // failed review is reported next to its own button, not as a failed
      // generation
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.persistConversation(conversationId)

      if (abortSignal?.aborted) return

      console.error('Style review error:', error)
      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
    }
  }

  async regenerateSection(
    request: RegenerationRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const generationKey = `${conversationId}-${request.sectionTitle}`

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh regeneration run owns generation state from here; without this
      // a previously completed run's state would swallow the progress updates
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false,
        sectionTitle: request.sectionTitle
      })

      // Build complete conversation history from all generations, normalised
      // to a single system message (story 8.13)
      const messages = buildConversationHistory(conversation, request.prompt)

      this.callbacks.dispatch({
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
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: ensureSectionHeading(request.sectionTitle, accumulated)
          })
        }
      )

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        sectionTitle: request.sectionTitle
      })

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: ensureSectionHeading(request.sectionTitle, sectionText)
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // The user stopped the regeneration: keep what streamed in and settle
      // quietly instead of surfacing an error banner
      if (abortSignal?.aborted) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true,
          sectionTitle: request.sectionTitle
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Section regeneration error:', error)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
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
    const generationKey = `${conversationId}-refine`

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh refinement run owns generation state from here
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      // Build complete conversation history from all generations, normalised
      // to a single system message (story 8.13)
      const messages = buildConversationHistory(conversation, request.prompt)

      this.callbacks.dispatch({
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
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: responseText
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // The user stopped the refinement: keep what streamed in
      if (abortSignal?.aborted) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Script refinement error:', error)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
    }
  }
}
