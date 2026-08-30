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
import { buildConversationHistory } from '../prompts'
import { STYLE_REVIEW_SECTION_TITLE } from '../critiquePass'
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

const replyFrames = (reply: Reply) =>
  'prose' in reply
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
