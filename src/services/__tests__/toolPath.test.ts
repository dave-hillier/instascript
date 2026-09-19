import { describe, it, expect, vi } from 'vitest'
import { RawScriptGenerationOrchestrator, renderOutlineFromToolCall } from '../rawScriptGenerationOrchestrator'
import type { RawGenerationCallbacks, RawScriptServices } from '../rawScriptGenerationOrchestrator'
import { rawConversationReducer } from '../../reducers/rawConversationReducer'
import type { RawConversationState, RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, ChatMessage } from '../../types/conversation'
import type { Script } from '../../types/script'
import type { ProviderCallOptions } from '../scriptGenerationService'
import type { ExampleScript } from '../exampleSearchService'
import type { ProviderFrame } from '../providerFrame'
import {
  CRITIQUE_RECORD_TOOL,
  GROUNDING_SELECT_TOOL,
  OUTLINE_WRITE_TOOL,
  SECTION_REVISE_TOOL,
  SECTION_WRITE_TOOL,
  WRITING_TOOLS
} from '../writingTools'
import {
  MAX_SECTION_ATTEMPTS,
  MAX_TOOL_HANDSHAKES,
  SECTION_REJECTION_BUDGET,
  SECTION_TARGET_WORDS,
  SECTION_MAX_WORDS
} from '../sectionQuality'
import { projectConversation, isRejectedGeneration } from '../scriptProjection'
import { buildConversationHistory, styleRuleNumbers } from '../prompts'
import { STYLE_REVIEW_SECTION_TITLE } from '../critiquePass'
import { OUTLINE_CRITIQUE_SECTION_TITLE } from '../outlineCritique'
import { SCRIPT_REVIEW_SECTION_TITLE } from '../scriptReview'
import { parseOutline } from '../conversationDocument'
import { reanchorSpan, SPAN_CONTEXT_CHARS } from '../span'
import {
  parseConversationFromYamlMarkdown,
  serializeConversationToYamlMarkdown
} from '../conversationParser'
import { textFrames, toolCallFrames } from './fixtures/streamFake'

// End-to-end coverage of the tool-writing path: the real orchestrator, the
// real reducer and the real projection, with a provider double that answers by
// calling tools the way a provider does — identity on every fragment,
// arguments cut at arbitrary characters, a finish reason at the end.

const words = (count: number): string =>
  Array.from({ length: count }, (_, i) => `word${i}`).join(' ')

const outlineArguments = (titles: string[]): string =>
  JSON.stringify({
    title: 'Deep Rest',
    sections: titles.map(title => ({
      title,
      description: `What ${title} covers.`,
      target_words: SECTION_TARGET_WORDS
    }))
  })

interface SectionRequest {
  sectionTitle: string
  messages: ChatMessage[]
  options?: ProviderCallOptions
}

// What the provider double answers one request with: a named tool call, or
// prose from a model that ignored the tools
type Reply =
  | { call: { name: string; args: string; id?: string; finishReason?: string | null } }
  | { prose: string }

// A reply a test streams itself, for the turns the one-call fixture cannot
// express — two calls in one turn, say
type ScriptedReply = Reply | (() => AsyncGenerator<ProviderFrame, void, unknown>)

interface Harness {
  orchestrator: RawScriptGenerationOrchestrator
  conversation: RawConversation
  getState: () => RawConversationState
  actions: RawConversationAction[]
  scriptUpdates: Partial<Script>[]
  sections: SectionRequest[]
  outlineOptions: () => ProviderCallOptions | undefined
  outlineRequests: Array<ProviderCallOptions | undefined>
}

const replyFrames = (reply: ScriptedReply) =>
  typeof reply === 'function'
    ? reply()
    : 'prose' in reply
    ? textFrames(reply.prose)
      : toolCallFrames(reply.call.name, reply.call.args, {
          id: reply.call.id ?? 'call_1',
          finishReason: reply.call.finishReason === undefined ? 'tool_calls' : reply.call.finishReason
        })

// `body` decides what the double writes for a given section and attempt; it
// returns a string for a tool call, or a prose reply when a test wants the
// fallback. `model` pins the run's mode the way a stored script does.
const createHarness = (
  options: {
    sectionTitles?: string[]
    body?: (sectionTitle: string, attempt: number) => string | { prose: string }
    model?: string
    onSectionStream?: (sectionTitle: string, attempt: number) => void
    // Answers a request with something other than the straightforward call:
    // the grounding_select a compliant model opens with, a call for the wrong
    // tool, a call naming the wrong section, or a stream that never finishes.
    // Returning null falls back to the ordinary `body` behaviour.
    outlineReply?: (attempt: number) => Reply | null
    sectionReply?: (sectionTitle: string, attempt: number) => Reply | null
    // Answers the outline-critique request, which is a judging turn rather
    // than a section: it is asked for by the same provider method and told
    // apart by its marker title.
    outlineCritiqueReply?: (attempt: number) => ScriptedReply | null
    examples?: ExampleScript[]
    // Runs the outline critique and the style-review pass, as the setting does
    reviewPassEnabled?: boolean
  } = {}
): Harness => {
  const sectionTitles = options.sectionTitles ?? ['Induction', 'Awakening']
  const body = options.body ?? (() => words(SECTION_TARGET_WORDS))

  const conversation: RawConversation = {
    id: 'conv-1',
    scriptId: 'script-1',
    generations: [],
    createdAt: 0,
    updatedAt: 0
  }

  let state: RawConversationState = {
    conversations: [conversation],
    currentGeneration: null,
    generationMachine: null,
    reviewReport: null
  }

  const actions: RawConversationAction[] = []
  const scriptUpdates: Partial<Script>[] = []
  const sections: SectionRequest[] = []
  const attempts = new Map<string, number>()
  const outlineRequests: Array<ProviderCallOptions | undefined> = []
  let outlineOptions: ProviderCallOptions | undefined
  let outlineAttempt = 0

  const services: RawScriptServices = {
    scriptService: {
      generateScript: (_request, _messages, _examples, _abortSignal, callOptions) => {
        outlineOptions = callOptions
        outlineRequests.push(callOptions)
        outlineAttempt += 1
        const scripted = options.outlineReply?.(outlineAttempt)
        if (scripted) return replyFrames(scripted)
        // A provider only calls tools when it is offered them, so the double
        // answers a request without them the way a prose run's provider does
        if (!callOptions?.tools) {
          return textFrames(
            `# Deep Rest\n` +
            sectionTitles.map(title => `## ${title}\nWhat ${title} covers.`).join('\n')
          )
        }
        return toolCallFrames(OUTLINE_WRITE_TOOL, outlineArguments(sectionTitles), {
          id: 'call_outline'
        })
      },
      regenerateSection: (request, messages, _abortSignal, callOptions) => {
        sections.push({ sectionTitle: request.sectionTitle, messages, options: callOptions })
        const attempt = (attempts.get(request.sectionTitle) ?? 0) + 1
        attempts.set(request.sectionTitle, attempt)

        if (request.sectionTitle === OUTLINE_CRITIQUE_SECTION_TITLE) {
          const critiqueReply = options.outlineCritiqueReply?.(attempt)
          if (critiqueReply) return replyFrames(critiqueReply)
        }

        options.onSectionStream?.(request.sectionTitle, attempt)

        const scripted = options.sectionReply?.(request.sectionTitle, attempt)
        if (scripted) return replyFrames(scripted)

        const written = body(request.sectionTitle, attempt)
        if (typeof written !== 'string') return textFrames(written.prose)

        return toolCallFrames(
          SECTION_WRITE_TOOL,
          JSON.stringify({ title: request.sectionTitle, body: written }),
          { id: `call_${request.sectionTitle}_${attempt}` }
        )
      }
    },
    exampleService: { searchExamples: async () => options.examples ?? [] }
  }

  const callbacks: RawGenerationCallbacks = {
    dispatch: action => {
      actions.push(action)
      state = rawConversationReducer(state, action)
    },
    appDispatch: action => { scriptUpdates.push(action.updates) },
    saveConversation: () => {},
    getConversation: id => state.conversations.find(entry => entry.id === id),
    getScript: () => ({ model: options.model ?? 'gpt-5' })
  }

  return {
    orchestrator: new RawScriptGenerationOrchestrator(services, callbacks, {
      reviewPassEnabled: options.reviewPassEnabled
    }),
    conversation,
    getState: () => state,
    actions,
    scriptUpdates,
    sections,
    outlineOptions: () => outlineOptions,
    outlineRequests
  }
}

const generationsOf = (harness: Harness) => harness.getState().conversations[0].generations

const callsFor = (harness: Harness, sectionTitle: string) =>
  generationsOf(harness)
    .flatMap(generation => generation.toolCalls ?? [])
    .filter(call => call.title === sectionTitle)

describe('the tool path writes the script by calling tools', () => {
  it('offers every writing tool on the outline request and on each section request', async () => {
    const harness = createHarness()

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(harness.outlineOptions()?.tools).toEqual(WRITING_TOOLS)
    expect(harness.sections).toHaveLength(2)
    for (const request of harness.sections) {
      expect(request.options?.tools).toEqual(WRITING_TOOLS)
    }
  })

  it('stores an outline_write call as the same markdown outline the prose path stores', async () => {
    const harness = createHarness()

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const outline = generationsOf(harness)[0]
    expect(outline.response).toBe(
      '# Deep Rest\n## Induction\nWhat Induction covers.\n## Awakening\nWhat Awakening covers.'
    )
    expect(outline.toolCalls).toEqual([
      { id: 'call_outline', name: OUTLINE_WRITE_TOOL, title: 'Deep Rest', status: 'accepted' }
    ])
  })

  it('accepts a section written inside the window on its first attempt', async () => {
    const harness = createHarness()

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(harness.sections.map(request => request.sectionTitle)).toEqual(['Induction', 'Awakening'])

    const call = callsFor(harness, 'Induction')[0]
    expect(call.status).toBe('accepted')
    expect(call.name).toBe(SECTION_WRITE_TOOL)
    expect(call.wordCount).toBe(SECTION_TARGET_WORDS)

    // D1: the response is always the rendered markdown, never empty
    const generation = generationsOf(harness).find(entry =>
      entry.toolCalls?.some(entry2 => entry2.title === 'Induction')
    )
    expect(generation?.response.startsWith('## Induction\n')).toBe(true)

    // D3: the call carries structure, not prose
    expect(JSON.stringify(call)).not.toContain('word0')
  })

  it('rejects an out-of-window section, tells the model its call failed, and accepts the rewrite', async () => {
    const harness = createHarness({
      body: (title, attempt) =>
        title === 'Induction' && attempt === 1
          ? words(SECTION_MAX_WORDS + 200)
          : words(SECTION_TARGET_WORDS)
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const calls = callsFor(harness, 'Induction')
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].wordCount).toBe(SECTION_MAX_WORDS + 200)
    expect(calls[0].reason).toContain('REJECTED')
    expect(calls[0].reason).toContain(`${SECTION_MAX_WORDS + 200} words`)

    // The rejection is delivered as the tool result answering the failed call,
    // in the local send-time array only
    const retry = harness.sections.filter(request => request.sectionTitle === 'Induction')[1]
    const turns = retry.options?.toolTurns ?? []
    expect(turns).toHaveLength(2)
    expect(turns[0].role).toBe('assistant')
    expect(turns[1]).toMatchObject({ role: 'tool', toolCallId: 'call_Induction_1' })
    expect(turns[1].role === 'tool' && turns[1].content).toContain('REJECTED')

    // D2: no tool-role turn is ever stored on a generation
    for (const generation of generationsOf(harness)) {
      for (const message of generation.messages) {
        expect(['system', 'user', 'assistant']).toContain(message.role)
      }
    }
  })

  it('folds a rejected attempt out of the document and keeps the accepted one', async () => {
    const rejectedBody = words(SECTION_MAX_WORDS + 200)
    const harness = createHarness({
      body: (title, attempt) =>
        title === 'Induction' && attempt === 1 ? rejectedBody : words(SECTION_TARGET_WORDS)
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.map(section => section.title)).toEqual(['Induction', 'Awakening'])
    const induction = document.sections[0]
    expect(induction.wordCount).toBe(SECTION_TARGET_WORDS)
    expect(induction.content).not.toBe(rejectedBody)
  })

  it('waives the closest attempt once the per-section cap is spent, and still finishes the script', async () => {
    // Every attempt misses, the second by the smallest margin
    const harness = createHarness({
      body: (title, attempt) =>
        title === 'Induction'
          ? words(attempt === 2 ? SECTION_MAX_WORDS + 10 : SECTION_MAX_WORDS + 400)
          : words(SECTION_TARGET_WORDS)
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const inductionRequests = harness.sections.filter(request => request.sectionTitle === 'Induction')
    expect(inductionRequests).toHaveLength(MAX_SECTION_ATTEMPTS)

    const calls = callsFor(harness, 'Induction')
    expect(calls.map(call => call.status)).toEqual([
      ...Array.from({ length: MAX_SECTION_ATTEMPTS - 1 }, () => 'rejected'),
      'waived'
    ])

    // The waiver keeps the attempt closest to the target, states the count it
    // was waived at, and stays visible as a waiver rather than an acceptance
    const waived = calls[calls.length - 1]
    expect(waived.wordCount).toBe(SECTION_MAX_WORDS + 10)
    expect(waived.reason).toContain(`${SECTION_MAX_WORDS + 10} words`)

    // The waived body is what the document and the finished script carry
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections[0].wordCount).toBe(SECTION_MAX_WORDS + 10)
    expect(harness.scriptUpdates.some(update => update.status === 'complete')).toBe(true)
    expect(harness.getState().generationMachine?.phase).toBe('complete')
  })

  it('short-circuits to a waiver once the run rejection budget is spent', async () => {
    const titles = ['One', 'Two', 'Three', 'Four', 'Five']
    const harness = createHarness({
      sectionTitles: titles,
      body: () => words(SECTION_MAX_WORDS + 300)
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const rejected = generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .filter(call => call.status === 'rejected')
    expect(rejected).toHaveLength(SECTION_REJECTION_BUDGET)

    // The budget runs out partway through, so the last sections are waived on
    // their first failing attempt instead of costing four requests each
    const lastSection = harness.sections.filter(request => request.sectionTitle === 'Five')
    expect(lastSection).toHaveLength(1)
    expect(callsFor(harness, 'Five').map(call => call.status)).toEqual(['waived'])

    // Every section still ends up in the script
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.map(section => section.title)).toEqual(titles)
  })

  it('never marks a call accepted when the stream is aborted mid-arguments (D6)', async () => {
    const controller = new AbortController()
    const body = words(SECTION_TARGET_WORDS)

    // A stream that aborts after the arguments are complete but before the
    // finish frame: the JSON parses, and the section is still not written
    async function* abortingCall(): AsyncGenerator<
      { kind: 'toolCall'; index: number; id: string; name: string; argumentsDelta: string },
      void,
      unknown
    > {
      yield {
        kind: 'toolCall',
        index: 0,
        id: 'call_aborted',
        name: SECTION_WRITE_TOOL,
        argumentsDelta: JSON.stringify({ title: 'Induction', body })
      }
      controller.abort()
      yield {
        kind: 'toolCall',
        index: 0,
        id: 'call_aborted',
        name: SECTION_WRITE_TOOL,
        argumentsDelta: ''
      }
    }

    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    services.scriptService.regenerateSection = () => abortingCall()

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation,
      controller.signal
    )

    const calls = generationsOf(harness).flatMap(generation => generation.toolCalls ?? [])
    expect(calls.some(call => call.title === 'Induction')).toBe(false)
    expect(calls.some(call => call.status === 'accepted' && call.name === SECTION_WRITE_TOOL)).toBe(false)
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('draft')
  })

  it('streams the live section in exactly the shape the prose path produces', async () => {
    const body = words(SECTION_TARGET_WORDS)

    const updatesOf = (harness: Harness): string[] =>
      harness.actions
        .filter(action => action.type === 'UPDATE_CURRENT_GENERATION')
        .map(action => (action as { response: string }).response)

    const byTool = createHarness({ body: () => body })
    await byTool.orchestrator.generateScript({ prompt: 'A deep rest script' }, byTool.conversation)

    // The same body, from a model that answered in prose instead
    const byProse = createHarness({ body: () => ({ prose: body }) })
    await byProse.orchestrator.generateScript({ prompt: 'A deep rest script' }, byProse.conversation)

    const toolUpdates = updatesOf(byTool).filter(update => update.startsWith('## Induction'))
    const proseUpdates = updatesOf(byProse).filter(update => update.startsWith('## Induction'))

    expect(toolUpdates.length).toBeGreaterThan(1)
    expect(toolUpdates[toolUpdates.length - 1]).toBe(`## Induction\n${body}`)
    expect(proseUpdates[proseUpdates.length - 1]).toBe(toolUpdates[toolUpdates.length - 1])
    // Every intermediate update is the heading followed by a prefix of the
    // body, which is exactly what a prose stream renders on its way there
    for (const update of toolUpdates) {
      expect(update.startsWith('## Induction\n')).toBe(true)
      expect(body.startsWith(update.slice('## Induction\n'.length))).toBe(true)
    }
  })

  it('runs the prose path unchanged for a model that cannot call tools', async () => {
    const harness = createHarness({
      model: 'gpt-3.5-turbo-instruct',
      body: () => ({ prose: words(SECTION_TARGET_WORDS) })
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(harness.outlineOptions()).toBeUndefined()
    for (const request of harness.sections) {
      expect(request.options).toBeUndefined()
    }
    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.toolCalls).toBeUndefined()
    }
  })

  it('falls back to the prose corrective retry when a tool-capable model answers in prose', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = createHarness({
      body: (title, attempt) => ({
        prose: words(title === 'Induction' && attempt === 1 ? 40 : SECTION_TARGET_WORDS)
      })
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const inductionRequests = harness.sections.filter(request => request.sectionTitle === 'Induction')
    expect(inductionRequests).toHaveLength(2)
    const retryPrompt = inductionRequests[1].messages[inductionRequests[1].messages.length - 1]
    expect(retryPrompt.role).toBe('user')
    expect(retryPrompt.content).toContain('which is too short')

    vi.restoreAllMocks()
  })
})

// A model reading these schemas is TOLD to call grounding_select first, and
// outline_write only after grounding — so a compliant model's opening move is
// a call the writing step is not waiting for. That has to be a handled turn,
// not a fall-through into the tool-less prose retry.
describe('a call that is not the one this turn needs', () => {
  const groundingReply = (id: string): Reply => ({
    call: { name: GROUNDING_SELECT_TOOL, args: JSON.stringify({ query: 'a deep rest script' }), id }
  })

  const examples: ExampleScript[] = [
    { content: 'first exemplar', metadata: { id: 'ex-1', title: 'Falling Asleep' } },
    { content: 'second exemplar', metadata: { id: 'ex-2', title: 'The Long Descent' } }
  ]

  const toolResultOf = (options?: ProviderCallOptions): string => {
    const turns = options?.toolTurns ?? []
    const result = turns.find(turn => turn.role === 'tool')
    return result && result.role === 'tool' ? result.content : ''
  }

  it('answers the grounding_select a compliant model opens the outline with, then gets the outline', async () => {
    const harness = createHarness({
      examples,
      outlineReply: attempt => (attempt === 1 ? groundingReply('call_ground') : null)
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    // The grounding call cost one request and the outline arrived on the next
    expect(harness.outlineRequests).toHaveLength(2)
    // Re-asked WITH the tools still attached (D4), carrying the exchange
    expect(harness.outlineRequests[1]?.tools).toEqual(WRITING_TOOLS)
    const turns = harness.outlineRequests[1]?.toolTurns ?? []
    expect(turns).toHaveLength(2)
    expect(turns[0].role).toBe('assistant')
    expect(turns[1]).toMatchObject({ role: 'tool', toolCallId: 'call_ground' })

    // The result is the selection the run already retrieved: ids, not prose (D3)
    const answer = toolResultOf(harness.outlineRequests[1])
    expect(answer).toContain('ex-1')
    expect(answer).toContain('ex-2')
    expect(answer).not.toContain('first exemplar')
    // and it names the tool the model should call next
    expect(answer).toContain(OUTLINE_WRITE_TOOL)

    // The run got its outline and wrote the whole script
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.title).toBe('Deep Rest')
    expect(document.sections.map(section => section.title)).toEqual(['Induction', 'Awakening'])
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('complete')

    // D1: nothing was stored with an empty response, the grounding turn included
    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.response.trim()).not.toBe('')
    }
  })

  it('answers a grounding_select that arrives on a section request instead of writing an empty section', async () => {
    const harness = createHarness({
      examples,
      sectionReply: (title, attempt) =>
        title === 'Induction' && attempt === 1 ? groundingReply('call_ground_section') : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const inductionRequests = harness.sections.filter(request => request.sectionTitle === 'Induction')
    expect(inductionRequests).toHaveLength(2)
    expect(inductionRequests[1].options?.tools).toEqual(WRITING_TOOLS)
    expect(toolResultOf(inductionRequests[1].options)).toContain(SECTION_WRITE_TOOL)

    // The section itself is written, not completed as an empty body
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections[0].title).toBe('Induction')
    expect(document.sections[0].wordCount).toBe(SECTION_TARGET_WORDS)
    expect(callsFor(harness, 'Induction').map(call => call.status)).toEqual(['accepted'])
    for (const generation of generationsOf(harness)) {
      expect(generation.response.trim()).not.toBe('')
    }
  })

  it('refuses a SECOND grounding_select and names the tool to call instead (D4)', async () => {
    const harness = createHarness({
      examples,
      outlineReply: attempt => (attempt === 1 ? groundingReply('call_ground') : null),
      sectionReply: (title, attempt) =>
        title === 'Induction' && attempt === 1 ? groundingReply('call_ground_again') : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const retry = harness.sections.filter(request => request.sectionTitle === 'Induction')[1]
    const answer = toolResultOf(retry.options)
    expect(answer).toContain('REFUSED')
    expect(answer).toContain('already')
    expect(answer).toContain(SECTION_WRITE_TOOL)
    // Refused by the handler, never by withdrawing the tool
    expect(retry.options?.tools).toEqual(WRITING_TOOLS)

    const refusal = generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .find(call => call.id === 'call_ground_again')
    expect(refusal?.status).toBe('rejected')
  })

  // The run-level grounding marker is set on the section path as well as the
  // outline path, and only a section-first ordering exercises that one: a model
  // that skips grounding at the outline and first calls it inside section 1
  // must still find it refused in section 2.
  it('refuses a second grounding_select even when the first one arrived inside a section', async () => {
    const harness = createHarness({
      examples,
      outlineReply: () => null,
      sectionReply: (title, attempt) =>
        attempt === 1 && (title === 'Induction' || title === 'Awakening')
          ? groundingReply(`call_ground_${title}`)
          : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    // Section 1 grounds the run, so its answer carries the selection
    const first = harness.sections.filter(request => request.sectionTitle === 'Induction')[1]
    expect(toolResultOf(first.options)).not.toContain('REFUSED')

    // Section 2 asks again and must be refused by the handler, not served
    const second = harness.sections.filter(request => request.sectionTitle === 'Awakening')[1]
    const answer = toolResultOf(second.options)
    expect(answer).toContain('REFUSED')
    expect(answer).toContain(SECTION_WRITE_TOOL)
    expect(second.options?.tools).toEqual(WRITING_TOOLS)

    const refusal = generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .find(call => call.id === 'call_ground_Awakening')
    expect(refusal?.status).toBe('rejected')
  })

  it('refuses a section_revise on a section that has not been written, and keeps the tools attached', async () => {
    const strayBody = words(SECTION_TARGET_WORDS)
    const harness = createHarness({
      sectionReply: (title, attempt) =>
        title === 'Induction' && attempt === 1
          ? {
              call: {
                name: SECTION_REVISE_TOOL,
                args: JSON.stringify({ title: 'Induction', body: strayBody, reason: 'tidier' }),
                id: 'call_revise'
              }
            }
          : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const revise = generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .find(call => call.name === SECTION_REVISE_TOOL)
    expect(revise?.status).toBe('rejected')

    const retry = harness.sections.filter(request => request.sectionTitle === 'Induction')[1]
    expect(retry.options?.tools).toEqual(WRITING_TOOLS)
    expect(toolResultOf(retry.options)).toContain(SECTION_WRITE_TOOL)
    // The refusal is a tool turn, not a tool-less prose retry
    expect((retry.options?.toolTurns ?? []).length).toBe(2)
  })

  it('gives up rather than spinning when the model never calls the writing tool', async () => {
    const harness = createHarness({
      sectionReply: (title) =>
        title === 'Induction' ? groundingReply('call_ground_forever') : null
    })

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow()

    expect(harness.sections.filter(request => request.sectionTitle === 'Induction'))
      .toHaveLength(MAX_TOOL_HANDSHAKES + 1)
  })
})

describe('the title a section is filed under is the one the call names', () => {
  it('refuses a section_write naming a different section and asks again for this one', async () => {
    const strayBody = words(SECTION_TARGET_WORDS + 3)
    const harness = createHarness({
      sectionReply: (title, attempt) =>
        title === 'Induction' && attempt === 1
          ? {
              call: {
                name: SECTION_WRITE_TOOL,
                args: JSON.stringify({ title: 'Awakening', body: strayBody }),
                id: 'call_wrong_title'
              }
            }
          : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const refused = generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .find(call => call.id === 'call_wrong_title')
    expect(refused?.status).toBe('rejected')
    expect(refused?.reason).toContain('Awakening')
    expect(refused?.reason).toContain('Induction')

    // The body that named another section was never filed as this one
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections[0].title).toBe('Induction')
    expect(document.sections[0].content).not.toBe(strayBody)
    expect(document.sections[0].wordCount).toBe(SECTION_TARGET_WORDS)
    expect(document.sections[1].content).not.toBe(strayBody)
  })
})

describe('only a body that actually arrived can be waived (D6)', () => {
  const truncatedCall = (title: string, id: string): Reply => ({
    call: {
      name: SECTION_WRITE_TOOL,
      args: JSON.stringify({ title, body: words(SECTION_TARGET_WORDS) }),
      id,
      // A stream that ends with no finish reason: an abort, or a dropped
      // connection. The JSON parses; the section still never arrived.
      finishReason: null
    }
  })

  it('fails the section instead of waiving a body from a stream that never finished', async () => {
    const harness = createHarness({
      sectionReply: (title, attempt) =>
        title === 'Induction' ? truncatedCall(title, `call_cut_${attempt}`) : null
    })

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow()

    const calls = generationsOf(harness).flatMap(generation => generation.toolCalls ?? [])
    expect(calls.some(call => call.status === 'waived')).toBe(false)
    expect(calls.some(call => call.status === 'accepted' && call.title === 'Induction')).toBe(false)
    // Nothing truncated reached the script, and the run is not reported complete
    expect(harness.scriptUpdates.some(update => update.status === 'complete')).toBe(false)
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('draft')
    expect(harness.getState().generationMachine?.phase).toBe('error')
  })

  it('never waives a zero-word body', async () => {
    const harness = createHarness({
      sectionReply: (title, attempt) =>
        title === 'Induction'
          ? {
              call: {
                name: SECTION_WRITE_TOOL,
                args: JSON.stringify({ title, body: '' }),
                id: `call_empty_${attempt}`
              }
            }
          : null
    })

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow()

    const calls = generationsOf(harness).flatMap(generation => generation.toolCalls ?? [])
    expect(calls.some(call => call.status === 'waived')).toBe(false)
  })

  it('ends an aborted run as a draft even when the last section landed', async () => {
    const controller = new AbortController()
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const original = services.scriptService.regenerateSection.bind(services.scriptService)

    // The abort arrives on the FINAL section's last frame: the body is whole,
    // the section is accepted, and the loop ends of its own accord — so
    // nothing after it would notice the run was stopped
    services.scriptService.regenerateSection = (request, messages, signal, callOptions) => {
      const inner = original(request, messages, signal, callOptions)
      if (request.sectionTitle !== 'Awakening') return inner
      return (async function* (): AsyncGenerator<ProviderFrame, void, unknown> {
        for await (const frame of inner) {
          if (frame.kind === 'finished') controller.abort()
          yield frame
        }
      })()
    }

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation,
      controller.signal
    )

    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('draft')
  })
})


// D6 says an abort or a 'length' truncation may never become stored content.
// Rejecting a body is only half of that: the generation the attempt opened is
// holding that body, and a path that throws without closing it leaves the body
// stored as an ordinary generation with no tool calls on it — the one shape
// nothing folds out.
describe('a refused body never survives as an unmarked generation (D6)', () => {
  const truncatedBody = words(950)

  const bodyIsStoredUnmarked = (harness: Harness): boolean =>
    generationsOf(harness).some(
      generation => generation.response.includes(truncatedBody) && !isRejectedGeneration(generation)
    )

  it('closes the generation as a refusal when no attempt at a section ever finished', async () => {
    const harness = createHarness({
      sectionReply: (title, attempt) =>
        title === 'Induction'
          ? {
              call: {
                name: SECTION_WRITE_TOOL,
                args: JSON.stringify({ title, body: truncatedBody }),
                id: `call_cut_${attempt}`,
                // The provider cut the model off mid-body
                finishReason: 'length'
              }
            }
          : null
    })

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow()

    // The body the run refused is stored, but only ever on a generation every
    // reader folds out
    expect(bodyIsStoredUnmarked(harness)).toBe(false)
    const last = generationsOf(harness)[generationsOf(harness).length - 1]
    expect(last.toolCalls?.map(call => call.status)).toEqual(['rejected'])
    expect(last.toolCalls?.[0].reason).toContain('length')

    // and it reaches neither the document nor the script
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.some(section => section.title === 'Induction')).toBe(false)
    expect(harness.scriptUpdates.some(update => update.status === 'complete')).toBe(false)

    // D1: nothing was stored with an empty response
    for (const generation of generationsOf(harness)) {
      expect(generation.response.trim()).not.toBe('')
    }
  })

  it('closes the generation as a refusal when the run is stopped on the last attempt', async () => {
    const controller = new AbortController()
    const harness = createHarness({
      sectionReply: (title, attempt) =>
        title === 'Induction'
          ? {
              call: {
                name: SECTION_WRITE_TOOL,
                args: JSON.stringify({ title, body: truncatedBody }),
                id: `call_stopped_${attempt}`
              }
            }
          : null
    })
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const original = services.scriptService.regenerateSection.bind(services.scriptService)
    let seen = 0

    // The user stops the run as the LAST attempt's stream finishes: the body
    // is whole, the attempts are spent, and the loop leaves through the abort
    // check inside the exhaustion branch with the generation still open
    services.scriptService.regenerateSection = (request, messages, signal, callOptions) => {
      const inner = original(request, messages, signal, callOptions)
      if (request.sectionTitle !== 'Induction') return inner
      seen += 1
      const isLast = seen === MAX_SECTION_ATTEMPTS
      return (async function* (): AsyncGenerator<ProviderFrame, void, unknown> {
        for await (const frame of inner) {
          if (isLast && frame.kind === 'finished') controller.abort()
          yield frame
        }
      })()
    }

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation,
      controller.signal
    )

    expect(seen).toBe(MAX_SECTION_ATTEMPTS)
    expect(bodyIsStoredUnmarked(harness)).toBe(false)
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('draft')
  })

  it('closes the generation when the section stream throws before its first frame', async () => {
    const controller = new AbortController()
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services

    // Stopped before anything arrived: the generation is open and empty, and a
    // generation stored with an empty response is dropped, prompt and all, by
    // the deployed parser (D1)
    services.scriptService.regenerateSection = () => {
      controller.abort()
      return textFrames('anything at all')
    }

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation,
      controller.signal
    )

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.response.trim()).not.toBe('')
    }
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('draft')
  })
})

// The prose reply these functions fall back to is stored as the outline or the
// section, so it is judged on the same finish the tool calls are (D6).
describe('a truncated prose reply is not stored as the outline or the section', () => {
  async function* truncatedProse(text: string): AsyncGenerator<ProviderFrame, void, unknown> {
    yield { kind: 'firstToken', at: Date.now() }
    yield { kind: 'text', delta: text }
    yield { kind: 'finished', reason: 'length' }
  }

  it('fails the run rather than storing an outline the provider cut off', async () => {
    const fragment = '# Deep Rest\n## Induction\nWhat Induction covers.\n## Awak'
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    services.scriptService.generateScript = () => truncatedProse(fragment)

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow('Failed to parse outline')

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.response).not.toContain('## Awak')
      expect(generation.response.trim()).not.toBe('')
    }
    expect(harness.scriptUpdates.some(update => update.status === 'complete')).toBe(false)
  })

  it('fails the section rather than storing a body the provider cut off', async () => {
    const fragment = words(120)
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const original = services.scriptService.regenerateSection.bind(services.scriptService)
    services.scriptService.regenerateSection = (request, messages, signal, callOptions) =>
      request.sectionTitle === 'Induction'
        ? truncatedProse(fragment)
        : original(request, messages, signal, callOptions)

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow('Induction')

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.response).not.toContain(fragment)
      expect(generation.response.trim()).not.toBe('')
    }
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.some(section => section.title === 'Induction')).toBe(false)
    expect(harness.scriptUpdates.some(update => update.status === 'complete')).toBe(false)
  })
})

// A run the user stopped is not a run that finished, whichever request the
// stop landed on. runOutlineCritique already rethrows an abort; the style
// review has to agree, or a stopped run is reported as a complete script.
describe('an abort during the review pass ends the run as a stopped run', () => {
  it('does not report a stopped run as complete', async () => {
    const controller = new AbortController()
    const harness = createHarness({ reviewPassEnabled: true })
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const original = services.scriptService.regenerateSection.bind(services.scriptService)

    services.scriptService.regenerateSection = (request, messages, signal, callOptions) => {
      if (request.sectionTitle !== STYLE_REVIEW_SECTION_TITLE) {
        return original(request, messages, signal, callOptions)
      }
      return (async function* (): AsyncGenerator<ProviderFrame, void, unknown> {
        yield { kind: 'firstToken', at: Date.now() }
        yield { kind: 'text', delta: 'Rule 1: ' }
        controller.abort()
        yield { kind: 'text', delta: 'violated' }
      })()
    }

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation,
      controller.signal
    )

    expect(harness.scriptUpdates.some(update => update.status === 'complete')).toBe(false)
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('draft')
    expect(harness.getState().generationMachine?.phase).not.toBe('complete')
  })

  it('still keeps the finished script when the review merely fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = createHarness({ reviewPassEnabled: true })
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const original = services.scriptService.regenerateSection.bind(services.scriptService)

    services.scriptService.regenerateSection = (request, messages, signal, callOptions) => {
      if (request.sectionTitle !== STYLE_REVIEW_SECTION_TITLE) {
        return original(request, messages, signal, callOptions)
      }
      return (async function* (): AsyncGenerator<ProviderFrame, void, unknown> {
        yield { kind: 'firstToken', at: Date.now() }
        throw new Error('the review request failed')
      })()
    }

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('complete')
    vi.restoreAllMocks()
  })
})

// The handshake turn wrote none of the script, so every reader that folds a
// conversation has to fold it out — otherwise its request messages, which are
// the outline request, are replayed alongside the outline request itself.
describe('the grounding handshake is folded out of the replayed history', () => {
  it('does not send the outline prompt twice on a later refinement', async () => {
    const harness = createHarness({
      examples: [{ content: 'first exemplar', metadata: { id: 'ex-1', title: 'Falling Asleep' } }],
      outlineReply: attempt =>
        attempt === 1
          ? {
              call: {
                name: GROUNDING_SELECT_TOOL,
                args: JSON.stringify({ query: 'a deep rest script' }),
                id: 'call_ground'
              }
            }
          : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const handshake = generationsOf(harness)[0]
    expect(handshake.toolCalls?.[0].name).toBe(GROUNDING_SELECT_TOOL)
    expect(isRejectedGeneration(handshake)).toBe(true)

    // The outline request, which the handshake generation stored byte for byte
    const outlineGeneration = generationsOf(harness)[1]
    const outlinePrompt = outlineGeneration.messages[outlineGeneration.messages.length - 1]
    expect(outlinePrompt.role).toBe('user')
    expect(handshake.messages).toEqual(outlineGeneration.messages)

    const history = buildConversationHistory(harness.getState().conversations[0], 'Make it warmer')
    const asked = history.filter(message => message.content === outlinePrompt.content)
    expect(asked).toHaveLength(1)
    // and the one-line record of the handshake is not replayed as model output
    expect(history.some(message => message.content.includes('Grounded in'))).toBe(false)
  })
})

describe('the outline generation is never stored empty (D1)', () => {
  it('records what happened when an outline_write call describes no usable plan', async () => {
    const harness = createHarness({
      outlineReply: () => ({
        call: { name: OUTLINE_WRITE_TOOL, args: '{"title":', id: 'call_broken_outline' }
      })
    })

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow('Failed to parse outline')

    const generations = generationsOf(harness)
    expect(generations.length).toBeGreaterThan(0)
    for (const generation of generations) {
      expect(generation.response.trim()).not.toBe('')
      // The prompt has to survive with it: a dropped generation takes its
      // messages too
      expect(generation.messages.length).toBeGreaterThan(0)
    }
  })
})

describe('renderOutlineFromToolCall', () => {
  it('renders a complete plan as the markdown the prose path stores', () => {
    expect(renderOutlineFromToolCall(outlineArguments(['Induction']))).toBe(
      '# Deep Rest\n## Induction\nWhat Induction covers.'
    )
  })

  it('returns null for arguments that are not JSON', () => {
    expect(renderOutlineFromToolCall('{"title":')).toBeNull()
  })

  it('returns null when no title was given', () => {
    expect(renderOutlineFromToolCall(JSON.stringify({ sections: [{ title: 'One' }] }))).toBeNull()
    expect(renderOutlineFromToolCall(JSON.stringify({ title: '   ', sections: [{ title: 'One' }] })))
      .toBeNull()
  })

  it('returns null when the plan has no sections', () => {
    expect(renderOutlineFromToolCall(JSON.stringify({ title: 'Deep Rest', sections: [] }))).toBeNull()
  })

  it('returns null when no section entry has a usable title', () => {
    expect(
      renderOutlineFromToolCall(
        JSON.stringify({ title: 'Deep Rest', sections: [{ description: 'no title' }, { title: '  ' }] })
      )
    ).toBeNull()
  })
})


// The frames that report what a request cost — firstToken, usage, finished —
// have been in the stream since the frame protocol landed with nothing reading
// them: `Generation.cachedTokens` was declared, reduced, persisted, parsed and
// asserted on without one line anywhere setting it, and the cost summary
// estimated tokens from a character count while the provider's own numbers
// went past unread. These tests are about the collection, so they assert on
// the conversation a save would write, through the real reducer.
describe('a generation records what its request cost', () => {
  const USAGE = { promptTokens: 900, completionTokens: 120, cachedTokens: 768 } as const

  // Wraps the harness's own provider double so every request it answers ends
  // the way a provider with stream_options.include_usage does: the usage block
  // rides its own final chunk, after the finish reason.
  const reportUsage = (harness: Harness): void => {
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const base = {
      generateScript: services.scriptService.generateScript,
      regenerateSection: services.scriptService.regenerateSection
    }
    const withUsage = async function* (
      frames: AsyncIterable<ProviderFrame>
    ): AsyncGenerator<ProviderFrame, void, unknown> {
      yield* frames
      yield { kind: 'usage', ...USAGE }
    }
    services.scriptService.generateScript = (...args) => withUsage(base.generateScript(...args))
    services.scriptService.regenerateSection = (...args) =>
      withUsage(base.regenerateSection(...args))
  }

  it('stores the provider’s own numbers on every generation of a tool run', async () => {
    const harness = createHarness()
    reportUsage(harness)

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const generations = generationsOf(harness)
    expect(generations.length).toBeGreaterThan(0)
    for (const generation of generations) {
      expect(generation.metrics?.promptTokens).toBe(900)
      expect(generation.metrics?.completionTokens).toBe(120)
      expect(generation.metrics?.cachedTokens).toBe(768)
      // 'tool_calls' for the outline and each section_write, as the double
      // finishes them
      expect(generation.metrics?.finishReason).toBe('tool_calls')
      expect(generation.metrics?.aborted).toBeUndefined()
    }
  })

  it('fills the cache-hit count nothing used to populate', async () => {
    const harness = createHarness()
    reportUsage(harness)

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.cachedTokens).toBe(768)
    }
  })

  it('measures the span and the latency to first token', async () => {
    const harness = createHarness()
    reportUsage(harness)
    const before = Date.now()

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const after = Date.now()
    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      const metrics = generation.metrics!
      expect(metrics.startedAt).toBeGreaterThanOrEqual(before)
      expect(metrics.endedAt).toBeLessThanOrEqual(after)
      expect(metrics.endedAt).toBeGreaterThanOrEqual(metrics.startedAt)
      expect(metrics.firstTokenAt).toBeGreaterThanOrEqual(before)
    }
  })

  it('records the prose path the same way, tools or no tools', async () => {
    const harness = createHarness({
      model: 'gpt-3.5-turbo-instruct',
      body: () => ({ prose: words(SECTION_TARGET_WORDS) })
    })
    reportUsage(harness)

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.toolCalls).toBeUndefined()
      expect(generation.metrics?.promptTokens).toBe(900)
      expect(generation.metrics?.finishReason).toBe('stop')
    }
  })

  it('leaves metrics off a run whose provider reported no usage at all', async () => {
    // The whole record is optional, one field at a time: a provider without
    // include_usage still gets a span and a finish reason, and no token counts
    // invented for it.
    const harness = createHarness()

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.metrics?.promptTokens).toBeUndefined()
      expect(generation.metrics?.completionTokens).toBeUndefined()
      expect(generation.cachedTokens).toBeUndefined()
      expect(generation.metrics?.startedAt).toBeGreaterThan(0)
    }
  })

  it('marks the turn a stopped run ended on as aborted', async () => {
    const controller = new AbortController()
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services

    // Stopped before anything arrived, which is the turn streamOrClose closes
    services.scriptService.regenerateSection = () => {
      controller.abort()
      return textFrames('anything at all')
    }

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation,
      controller.signal
    )

    const closed = generationsOf(harness)[generationsOf(harness).length - 1]
    expect(closed.response).toContain('ended before the model finished')
    expect(closed.metrics?.aborted).toBe(true)
    // The outline turn ran to its own end, so it is not marked
    expect(generationsOf(harness)[0].metrics?.aborted).toBeUndefined()
  })

  it('keeps the first token time the stream reported first', async () => {
    // A stream that somehow reports first-token twice is reporting the same
    // first token, so the earlier reading is the true one and the later one
    // must not overwrite it
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const base = {
      generateScript: services.scriptService.generateScript,
      regenerateSection: services.scriptService.regenerateSection
    }
    const reportedTwice = async function* (
      frames: AsyncIterable<ProviderFrame>
    ): AsyncGenerator<ProviderFrame, void, unknown> {
      yield { kind: 'firstToken', at: 1000 }
      for await (const frame of frames) {
        yield frame.kind === 'firstToken' ? { kind: 'firstToken', at: 9000 } : frame
      }
    }
    services.scriptService.generateScript = (...args) => reportedTwice(base.generateScript(...args))
    services.scriptService.regenerateSection = (...args) =>
      reportedTwice(base.regenerateSection(...args))

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    expect(generationsOf(harness).length).toBeGreaterThan(0)
    for (const generation of generationsOf(harness)) {
      expect(generation.metrics?.firstTokenAt).toBe(1000)
    }
  })

  it('never hands a turn that made no request of its own the previous turn’s numbers', async () => {
    // The outline turn's record is taken and REMOVED as it is stored. The
    // section turn below opens a generation and then fails before it reaches a
    // stream at all, so it has nothing measured to report — and must say so,
    // rather than being closed carrying the outline request's usage.
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const base = services.scriptService.generateScript
    services.scriptService.generateScript = (...args) =>
      (async function* (): AsyncGenerator<ProviderFrame, void, unknown> {
        yield* base(...args)
        yield { kind: 'usage', promptTokens: 900, completionTokens: 120 }
      })()
    services.scriptService.regenerateSection = () => {
      throw new Error('the request never went out')
    }

    await expect(
      harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)
    ).rejects.toThrow()

    const generations = generationsOf(harness)
    expect(generations[0].metrics?.promptTokens).toBe(900)

    const closed = generations[generations.length - 1]
    expect(closed.response).toContain('ended before the model finished')
    expect(closed.metrics).toBeUndefined()
  })

  it('gives each turn its own record rather than the previous turn’s', async () => {
    const harness = createHarness()
    const services = (harness.orchestrator as unknown as { services: RawScriptServices }).services
    const base = services.scriptService.regenerateSection
    let request = 0
    services.scriptService.regenerateSection = (...args) => {
      request += 1
      const completionTokens = request * 100
      const frames = base(...args)
      return (async function* (): AsyncGenerator<ProviderFrame, void, unknown> {
        yield* frames
        yield { kind: 'usage', promptTokens: 900, completionTokens }
      })()
    }

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const sectionGenerations = generationsOf(harness).filter(generation =>
      generation.toolCalls?.some(call => call.name === SECTION_WRITE_TOOL)
    )
    expect(sectionGenerations.map(generation => generation.metrics?.completionTokens))
      .toEqual([100, 200])
  })
})

// --- what round each generation of a tool-written run belongs to -----------

describe('the rounds a tool-written run records', () => {
  it('files every attempt at one section under the single round that planned it', async () => {
    const harness = createHarness({
      body: (title, attempt) =>
        title === 'Induction' && attempt === 1
          ? words(SECTION_MAX_WORDS + 200)
          : words(SECTION_TARGET_WORDS)
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    // Two generations for Induction — the refused draft and the rewrite —
    // and one round between them: a round is what the plan asked for, not
    // what it took to deliver.
    const induction = generationsOf(harness).filter(generation =>
      (generation.toolCalls ?? []).some(call => call.title === 'Induction'))
    expect(induction).toHaveLength(2)
    expect(induction[0].round).toEqual({ round: 2, kind: 'section', sectionIndex: 0 })
    expect(induction[1].round).toEqual({ round: 2, kind: 'section', sectionIndex: 0 })

    const rounds = generationsOf(harness).map(generation => generation.round!)
    expect(rounds[0]).toEqual({ round: 1, kind: 'outline' })
    expect(rounds[rounds.length - 1])
      .toEqual({ round: 3, kind: 'section', sectionIndex: 1 })
  })

  it('files a handshake turn under the round it was answering for', async () => {
    const harness = createHarness({
      outlineReply: attempt =>
        attempt === 1
          ? { call: { name: GROUNDING_SELECT_TOOL, args: '{"query":"deep rest"}', id: 'call_g' } }
          : null
    })

    await harness.orchestrator.generateScript({ prompt: 'A deep rest script' }, harness.conversation)

    const generations = generationsOf(harness)
    expect(generationsOf(harness).length).toBeGreaterThan(0)
    // The refusal turn and the outline that followed it are one round
    expect(generations[0].round).toEqual({ round: 1, kind: 'outline' })
    expect(generations[1].round).toEqual({ round: 1, kind: 'outline' })
  })
})

// The style pass on the tool path. It judges the script and RECORDS what it
// found; it rewrites nothing, and a quote it did not read off the section is
// refused through the same tool-result handshake a mis-sized body gets.
describe('the style pass records a critique rather than rewriting sections', () => {
  const SECTIONS = ['Induction', 'Awakening']

  // The body every section is written with here, so a test can quote out of it
  const BODY = words(SECTION_TARGET_WORDS)

  const critiqueArguments = (findings: unknown[], verdict = 'revise'): string =>
    JSON.stringify({ stage: 'style', verdict, findings })

  // Runs a whole tool-written run with the style pass on, answering the
  // critique request with `replies` in order and everything else normally.
  const runWithCritiques = async (replies: Array<Reply | null>) => {
    let critiqueTurn = 0
    const harness = createHarness({
      sectionTitles: SECTIONS,
      reviewPassEnabled: true,
      body: () => BODY,
      sectionReply: sectionTitle => {
        if (sectionTitle !== STYLE_REVIEW_SECTION_TITLE) return null
        const reply = replies[critiqueTurn] ?? replies[replies.length - 1]
        critiqueTurn += 1
        return reply
      }
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )
    return { harness, critiqueTurns: () => critiqueTurn }
  }

  const critiqueCalls = (harness: Harness) =>
    generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .filter(call => call.name === CRITIQUE_RECORD_TOOL)

  it('offers the tools on the critique request, so the critique can be a call at all', async () => {
    const { harness } = await runWithCritiques([
      { call: { name: CRITIQUE_RECORD_TOOL, args: critiqueArguments([], 'pass'), id: 'call_c1' } }
    ])

    const request = harness.sections.find(entry => entry.sectionTitle === STYLE_REVIEW_SECTION_TITLE)
    expect(request?.options?.tools).toEqual(WRITING_TOOLS)
  })

  it('accepts an approving critique and stops, leaving the script untouched', async () => {
    const { harness, critiqueTurns } = await runWithCritiques([
      { call: { name: CRITIQUE_RECORD_TOOL, args: critiqueArguments([], 'pass'), id: 'call_c1' } }
    ])

    expect(critiqueTurns()).toBe(1)
    expect(critiqueCalls(harness).map(call => call.status)).toEqual(['accepted'])
    // Every planned section written exactly once: nothing was rewritten
    for (const title of SECTIONS) {
      expect(callsFor(harness, title)).toHaveLength(1)
    }
    const last = generationsOf(harness).slice(-1)[0]
    expect(last.response).toContain('approved the script')
  })

  it('pins a verbatim quote to the section it names', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness } = await runWithCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([
            { section: 'Induction', rules: [6], spans: [quote], reason: 'Ocean imagery.' }
          ]),
          id: 'call_c1'
        }
      }
    ])

    expect(critiqueCalls(harness).map(call => call.status)).toEqual(['accepted'])
    const report = harness.actions.find(action => action.type === 'REVIEW_PASS_COMPLETED')
    expect(report && report.type === 'REVIEW_PASS_COMPLETED' && report.report.revised).toEqual([
      { sectionTitle: 'Induction', ruleNumbers: [6], reason: 'Ocean imagery.' }
    ])
    // The pinned quote is read back to the model in the stored generation
    expect(generationsOf(harness).slice(-1)[0].response).toContain(`"${quote}"`)
  })

  it('carries the finding into the reading view, and back out of a reload', async () => {
    // The seam the whole model half of the feature hangs on. A finding that
    // is accepted but never written onto the generation lives for the length
    // of one function call: nothing draws it, nothing lists it, and a reload
    // reads a document that was never told the pass happened.
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness } = await runWithCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([
            { section: 'Induction', rules: [6], spans: [quote], reason: 'Ocean imagery.' }
          ]),
          id: 'call_c1'
        }
      }
    ])

    const stored = harness.getState().conversations[0]
    const document = projectConversation(stored)
    expect(document.findings).toEqual([
      {
        stage: 'style',
        section: 'Induction',
        rules: [6],
        spans: [{
          quote,
          before: '',
          after: BODY.slice(quote.length, quote.length + SPAN_CONTEXT_CHARS),
          occurrence: 0
        }],
        revisions: 0,
        reason: 'Ocean imagery.'
      }
    ])
    // and it points at words that are really in the section it names
    const marked = document.sections.find(section => section.title === 'Induction')!
    const span = document.findings![0].spans![0]
    expect(reanchorSpan(marked.content, span)).toMatchObject({ state: 'anchored' })

    // The reload: the same conversation through the file it is stored as
    const reloaded = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(stored)
    )
    expect(reloaded).not.toBeNull()
    expect(projectConversation(reloaded!).findings).toEqual(document.findings)
  })

  it('refuses a quote that is not in the section, names the fault, and asks again', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness, critiqueTurns } = await runWithCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([
            { section: 'Induction', spans: ['a sentence the section never contained'], reason: 'x' }
          ]),
          id: 'call_c1'
        }
      },
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([{ section: 'Induction', spans: [quote], reason: 'x' }]),
          id: 'call_c2'
        }
      }
    ])

    expect(critiqueTurns()).toBe(2)
    const calls = critiqueCalls(harness)
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].reason).toContain('was not found in "Induction"')

    // The refusal went back as a TOOL RESULT on the retry, not as prose
    const retry = harness.sections.filter(
      entry => entry.sectionTitle === STYLE_REVIEW_SECTION_TITLE
    )[1]
    const turns = retry.options?.toolTurns ?? []
    expect(turns.map(turn => turn.role)).toEqual(['assistant', 'tool'])
    expect(turns[1].role === 'tool' && turns[1].content).toContain('was not found')
  })

  // The stage is the model's claim about which pass it is answering, and a
  // claim is not evidence. Recorded unchecked, a style pass that calls itself a
  // review is stored as a review, and the reading view then tells the reader a
  // finding came from a pass that never ran.
  it('refuses a critique that names a stage other than the pass that is running', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness } = await runWithCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: JSON.stringify({
            stage: 'review',
            verdict: 'revise',
            findings: [{ section: 'Induction', spans: [quote], reason: 'x' }]
          }),
          id: 'call_c1'
        }
      },
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([{ section: 'Induction', spans: [quote], reason: 'x' }]),
          id: 'call_c2'
        }
      }
    ])

    const calls = critiqueCalls(harness)
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].reason).toContain('this is the style pass')

    // And what was finally recorded is the pass that actually ran
    const findings = projectConversation(harness.getState().conversations[0]).findings ?? []
    expect(findings.map(finding => finding.stage)).toEqual(['style'])
  })

  it('refuses a rule number no style rule carries', async () => {
    const invented = Math.max(...styleRuleNumbers()) + 13
    const { harness } = await runWithCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([
            { section: 'Induction', rules: [invented], reason: 'Breaks a rule I made up.' }
          ]),
          id: 'call_c1'
        }
      },
      { call: { name: CRITIQUE_RECORD_TOOL, args: critiqueArguments([], 'pass'), id: 'call_c2' } }
    ])

    const calls = critiqueCalls(harness)
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].reason).toContain('must name a style rule')
  })

  it('gives up after MAX_TOOL_HANDSHAKES refusals without failing the finished script', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { harness, critiqueTurns } = await runWithCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: critiqueArguments([{ section: 'Induction', spans: ['never in the body'], reason: 'x' }]),
          id: 'call_c1'
        }
      }
    ])

    expect(critiqueTurns()).toBe(MAX_TOOL_HANDSHAKES + 1)
    expect(critiqueCalls(harness).every(call => call.status === 'rejected')).toBe(true)
    // The run still completes: a review that cannot land leaves a usable script
    expect(harness.scriptUpdates[harness.scriptUpdates.length - 1].status).toBe('complete')
    expect(harness.actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(false)
    vi.restoreAllMocks()
  })

  it('still reads a prose critique, as findings that quote nothing', async () => {
    const { harness } = await runWithCritiques([
      { prose: 'VERDICT: Induction | compliant\nVERDICT: Awakening | violates 9 | Negations.' }
    ])

    const report = harness.actions.find(action => action.type === 'REVIEW_PASS_COMPLETED')
    expect(report && report.type === 'REVIEW_PASS_COMPLETED' && report.report.revised).toEqual([
      { sectionTitle: 'Awakening', ruleNumbers: [9], reason: 'Negations.' }
    ])
    expect(critiqueCalls(harness)).toHaveLength(0)
    for (const title of SECTIONS) {
      expect(callsFor(harness, title)).toHaveLength(1)
    }
  })
})

// Two calls in one turn, which is what a model does when it judges the plan
// and re-issues it in the same breath. The shared fixture carries one call per
// stream; this is the same protocol with a second index alongside it.
async function* twoCallFrames(
  first: { name: string; args: string; id: string },
  second: { name: string; args: string; id: string }
): AsyncGenerator<ProviderFrame, void, unknown> {
  yield { kind: 'firstToken', at: Date.now() }
  const calls = [first, second]
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    for (let i = 0; i < call.args.length; i += 7) {
      yield {
        kind: 'toolCall',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.args.slice(i, i + 7)
      }
    }
  }
  yield { kind: 'finished', reason: 'tool_calls' }
}

describe('the outline critique records what it found', () => {
  const SECTIONS = ['Induction', 'Awakening']

  const outlineCritiqueArguments = (findings: unknown[], verdict = 'revise'): string =>
    JSON.stringify({ stage: 'outline', verdict, findings })

  // A whole tool-written run with the optional passes on, answering the
  // OUTLINE critique with `replies` in order. The style pass that follows it
  // approves, so nothing it does can be mistaken for what this pass did.
  const runWithOutlineCritiques = async (
    replies: Array<Reply | (() => AsyncGenerator<ProviderFrame, void, unknown>)>
  ) => {
    let critiqueTurn = 0
    const harness = createHarness({
      sectionTitles: SECTIONS,
      reviewPassEnabled: true,
      sectionReply: sectionTitle => {
        if (sectionTitle === STYLE_REVIEW_SECTION_TITLE) {
          return {
            call: {
              name: CRITIQUE_RECORD_TOOL,
              args: JSON.stringify({ stage: 'style', verdict: 'pass', findings: [] }),
              id: 'call_style'
            }
          }
        }
        return null
      },
      outlineCritiqueReply: () => {
        const reply = replies[critiqueTurn] ?? replies[replies.length - 1]
        critiqueTurn += 1
        return reply
      }
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )
    return { harness, critiqueTurns: () => critiqueTurn }
  }

  const outlineCritiqueCalls = (harness: Harness) =>
    generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .filter(call => call.name === CRITIQUE_RECORD_TOOL)

  it('offers the tools on the outline-critique request, so the critique can be a call at all', async () => {
    const { harness } = await runWithOutlineCritiques([
      { call: { name: CRITIQUE_RECORD_TOOL, args: outlineCritiqueArguments([], 'pass'), id: 'call_o1' } }
    ])

    const request = harness.sections.find(
      entry => entry.sectionTitle === OUTLINE_CRITIQUE_SECTION_TITLE
    )
    expect(request?.options?.tools).toEqual(WRITING_TOOLS)
  })

  it('records an approving critique of the plan and leaves the plan alone', async () => {
    const { harness, critiqueTurns } = await runWithOutlineCritiques([
      { call: { name: CRITIQUE_RECORD_TOOL, args: outlineCritiqueArguments([], 'pass'), id: 'call_o1' } }
    ])

    expect(critiqueTurns()).toBe(1)
    const recorded = outlineCritiqueCalls(harness).filter(call => call.id === 'call_o1')
    expect(recorded.map(call => call.status)).toEqual(['accepted'])
    // Named for the pass that ran, not for the one this code was copied from
    expect(recorded[0].reason).toBe('The outline pass approved the script.')

    // The plan the run wrote is the plan every section is written against
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.map(section => section.title)).toEqual(SECTIONS)
  })

  it('marks the plan, and the mark reaches the reading view stamped as the outline pass', async () => {
    const { harness } = await runWithOutlineCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: outlineCritiqueArguments([
            { section: 'Awakening', reason: 'Nothing plants the anchor this section pays off.' }
          ]),
          id: 'call_o1'
        }
      }
    ])

    const stored = harness.getState().conversations[0]
    expect(projectConversation(stored).findings).toEqual([
      {
        stage: 'outline',
        section: 'Awakening',
        reason: 'Nothing plants the anchor this section pays off.'
      }
    ])

    // and it is still there after a round trip through the file it is stored as
    const reloaded = parseConversationFromYamlMarkdown(serializeConversationToYamlMarkdown(stored))
    expect(projectConversation(reloaded!).findings)
      .toEqual(projectConversation(stored).findings)
  })

  // The one rule this stage has that the others do not. Nothing is written
  // yet, so a "quoted passage" could only be a line of the plan passed off as
  // a line of the script, or an invention.
  it('refuses a quoted passage, because no section is written yet', async () => {
    const { harness, critiqueTurns } = await runWithOutlineCritiques([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: outlineCritiqueArguments([
            { section: 'Awakening', spans: ['a passage nobody has written'], reason: 'Thin.' }
          ]),
          id: 'call_o1'
        }
      },
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: outlineCritiqueArguments([{ section: 'Awakening', reason: 'Thin.' }]),
          id: 'call_o2'
        }
      }
    ])

    expect(critiqueTurns()).toBe(2)
    const calls = outlineCritiqueCalls(harness).filter(call => call.id.startsWith('call_o'))
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].reason).toContain('is not written yet')

    // The refusal went back as a tool result on the retry, not as prose
    const retry = harness.sections.filter(
      entry => entry.sectionTitle === OUTLINE_CRITIQUE_SECTION_TITLE
    )[1]
    const turns = retry.options?.toolTurns ?? []
    expect(turns.map(turn => turn.role)).toEqual(['assistant', 'tool'])
    expect(turns[1].role === 'tool' && turns[1].content).toContain('is not written yet')

    // And the finding that was finally recorded quotes nothing
    const findings = projectConversation(harness.getState().conversations[0]).findings ?? []
    expect(findings).toEqual([{ stage: 'outline', section: 'Awakening', reason: 'Thin.' }])
  })

  // Recording the critique is ADDITIVE: revising the plan is what this step
  // has always done, and it still does it.
  it('takes the revised plan from an outline_write call in the same turn as the critique', async () => {
    const revised = ['Induction', 'Deepening', 'Return']
    const { harness } = await runWithOutlineCritiques([
      () => twoCallFrames(
        {
          name: CRITIQUE_RECORD_TOOL,
          args: outlineCritiqueArguments([
            { section: 'Awakening', reason: 'Carries the whole return on its own.' }
          ]),
          id: 'call_o1'
        },
        { name: OUTLINE_WRITE_TOOL, args: outlineArguments(revised), id: 'call_o_plan' }
      )
    ])

    // Every section of the REVISED plan is written, and the superseded one is
    // not: the critique's generation is what latest-outline-wins reads
    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.map(section => section.title)).toEqual(revised)
    expect(document.outline?.sections.map(section => section.title)).toEqual(revised)

    // The critique is recorded on the same generation the revised plan is
    const critiqued = generationsOf(harness).find(generation => generation.critique !== undefined)
    expect(critiqued?.critique?.stage).toBe('outline')
    expect(critiqued?.response.startsWith('# ')).toBe(true)
    expect(parseOutline(critiqued!.response)?.sections.map(section => section.title))
      .toEqual(revised)
  })

  // The prose path is not a failure mode: a model that cannot call tools still
  // answers this step the way it always has.
  it('still takes a revised plan written out in prose, recording no critique for it', async () => {
    const { harness } = await runWithOutlineCritiques([
      { prose: '# Deep Rest\n## Induction\nWhat Induction covers.\n## Return\nWhat Return covers.' }
    ])

    const document = projectConversation(harness.getState().conversations[0])
    expect(document.sections.map(section => section.title)).toEqual(['Induction', 'Return'])
    const findings = document.findings ?? []
    expect(findings.some(finding => finding.stage === 'outline')).toBe(false)
  })

  // The gate the planner reads is the ROUND RECORD, not the critique, and
  // recording one must not change when the pass fires.
  it('does not critique the outline again when its record is already in the conversation', async () => {
    const { harness } = await runWithOutlineCritiques([
      { call: { name: CRITIQUE_RECORD_TOOL, args: outlineCritiqueArguments([], 'pass'), id: 'call_o1' } }
    ])

    const written = harness.getState().conversations[0].generations
    const resumed = createHarness({ sectionTitles: SECTIONS, reviewPassEnabled: true })
    resumed.conversation.generations.push(...written)

    await resumed.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      resumed.conversation
    )

    // Not one further request: neither the outline critique nor the style pass
    // ran a second time over a conversation that records both
    expect(resumed.getState().conversations[0].generations).toHaveLength(written.length)
    expect(resumed.sections.map(request => request.sectionTitle)).toEqual([])
  })
})

describe('the whole-script review records what it found', () => {
  const SECTIONS = ['Induction', 'Awakening']
  const BODY = words(SECTION_TARGET_WORDS)

  const reviewArguments = (findings: unknown[], verdict = 'revise'): string =>
    JSON.stringify({ stage: 'review', verdict, findings })

  // A finished tool-written script, then the reader's press of the review
  // button, with the review request answered by `replies` in order.
  const runWithReviews = async (replies: Array<Reply | null>) => {
    let reviewTurn = 0
    const harness = createHarness({
      sectionTitles: SECTIONS,
      body: () => BODY,
      sectionReply: sectionTitle => {
        if (sectionTitle !== SCRIPT_REVIEW_SECTION_TITLE) return null
        const reply = replies[reviewTurn] ?? replies[replies.length - 1]
        reviewTurn += 1
        return reply
      }
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )
    const written = generationsOf(harness).length

    await harness.orchestrator.reviewScript(
      harness.getState().conversations[0],
      'A deep rest script'
    )

    return { harness, reviewTurns: () => reviewTurn, written }
  }

  const reviewCalls = (harness: Harness) =>
    generationsOf(harness)
      .flatMap(generation => generation.toolCalls ?? [])
      .filter(call => call.name === CRITIQUE_RECORD_TOOL)

  it('offers the tools on the review request, so the review can be a call at all', async () => {
    const { harness } = await runWithReviews([
      { call: { name: CRITIQUE_RECORD_TOOL, args: reviewArguments([], 'pass'), id: 'call_r1' } }
    ])

    const request = harness.sections.find(
      entry => entry.sectionTitle === SCRIPT_REVIEW_SECTION_TITLE
    )
    expect(request?.options?.tools).toEqual(WRITING_TOOLS)
  })

  it('pins the quoted passage to the section it names and rewrites nothing', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness, reviewTurns, written } = await runWithReviews([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: reviewArguments([
            { section: 'Awakening', spans: [quote], reason: 'Never pays off the anchor.' }
          ]),
          id: 'call_r1'
        }
      }
    ])

    expect(reviewTurns()).toBe(1)
    expect(reviewCalls(harness).map(call => call.status)).toEqual(['accepted'])
    expect(reviewCalls(harness)[0].reason).toBe('The review pass marked 1 section(s).')

    // The press adds ITS OWN generation and no other: the old pass rewrote up
    // to three sections here, each of which was a generation
    expect(generationsOf(harness)).toHaveLength(written + 1)
    for (const title of SECTIONS) {
      expect(callsFor(harness, title)).toHaveLength(1)
    }

    // The mark reaches the reading view, stamped with the pass that made it,
    // and points at words that are really in the section it names
    const stored = harness.getState().conversations[0]
    const document = projectConversation(stored)
    expect(document.findings).toEqual([
      {
        stage: 'review',
        section: 'Awakening',
        spans: [{
          quote,
          before: '',
          after: BODY.slice(quote.length, quote.length + SPAN_CONTEXT_CHARS),
          occurrence: 0
        }],
        revisions: 0,
        reason: 'Never pays off the anchor.'
      }
    ])
    const marked = document.sections.find(section => section.title === 'Awakening')!
    expect(reanchorSpan(marked.content, document.findings![0].spans![0]))
      .toMatchObject({ state: 'anchored' })

    // and survives the file it is stored as
    const reloaded = parseConversationFromYamlMarkdown(serializeConversationToYamlMarkdown(stored))
    expect(projectConversation(reloaded!).findings).toEqual(document.findings)
  })

  it('refuses a critique that names a stage other than the review that is running', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness } = await runWithReviews([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: JSON.stringify({
            stage: 'style',
            verdict: 'revise',
            findings: [{ section: 'Awakening', spans: [quote], reason: 'x' }]
          }),
          id: 'call_r1'
        }
      },
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: reviewArguments([{ section: 'Awakening', spans: [quote], reason: 'x' }]),
          id: 'call_r2'
        }
      }
    ])

    const calls = reviewCalls(harness)
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].reason).toContain('this is the review pass')
    expect(projectConversation(harness.getState().conversations[0]).findings!
      .map(finding => finding.stage)).toEqual(['review'])
  })

  it('refuses a quote the section does not carry, and asks again', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness, reviewTurns } = await runWithReviews([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: reviewArguments([
            { section: 'Awakening', spans: ['a sentence the section never contained'], reason: 'x' }
          ]),
          id: 'call_r1'
        }
      },
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: reviewArguments([{ section: 'Awakening', spans: [quote], reason: 'x' }]),
          id: 'call_r2'
        }
      }
    ])

    expect(reviewTurns()).toBe(2)
    const calls = reviewCalls(harness)
    expect(calls.map(call => call.status)).toEqual(['rejected', 'accepted'])
    expect(calls[0].reason).toContain('was not found in "Awakening"')
  })

  it('still reads a prose review, as findings that quote nothing', async () => {
    const { harness, written } = await runWithReviews([
      { prose: 'VERDICT: Induction | cohesive\nVERDICT: Awakening | revise | Resets the depth.' }
    ])

    const report = harness.actions.find(action => action.type === 'REVIEW_PASS_COMPLETED')
    expect(report && report.type === 'REVIEW_PASS_COMPLETED' && report.report.revised).toEqual([
      { sectionTitle: 'Awakening', reason: 'Resets the depth.' }
    ])
    expect(reviewCalls(harness)).toHaveLength(0)
    expect(generationsOf(harness)).toHaveLength(written + 1)

    const findings = projectConversation(harness.getState().conversations[0]).findings ?? []
    expect(findings).toEqual([
      { stage: 'review', section: 'Awakening', reason: 'Resets the depth.' }
    ])
  })

  // The reader's button is not gated by a round record, and recording a
  // critique must not start gating it: a second press reviews the script again.
  it('can be pressed again, and the later critique replaces the earlier one', async () => {
    const quote = BODY.split(' ').slice(0, 6).join(' ')
    const { harness } = await runWithReviews([
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: reviewArguments([{ section: 'Awakening', spans: [quote], reason: 'First press.' }]),
          id: 'call_r1'
        }
      },
      {
        call: {
          name: CRITIQUE_RECORD_TOOL,
          args: reviewArguments([{ section: 'Induction', spans: [quote], reason: 'Second press.' }]),
          id: 'call_r2'
        }
      }
    ])

    const afterFirst = generationsOf(harness).length
    await harness.orchestrator.reviewScript(
      harness.getState().conversations[0],
      'A deep rest script'
    )

    expect(generationsOf(harness)).toHaveLength(afterFirst + 1)
    const findings = projectConversation(harness.getState().conversations[0]).findings ?? []
    expect(findings.map(finding => finding.reason)).toEqual(['Second press.'])
  })
})
