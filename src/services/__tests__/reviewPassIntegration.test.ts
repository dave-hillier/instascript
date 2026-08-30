import { describe, it, expect, vi } from 'vitest'
import { RawScriptGenerationOrchestrator } from '../rawScriptGenerationOrchestrator'
import type { RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import { MockAPIService } from '../mockApi'
import { MAX_SCRIPT_REVIEW_REVISIONS, SCRIPT_REVIEW_SECTION_TITLE } from '../scriptReview'
import { STYLE_REVIEW_SECTION_TITLE } from '../critiquePass'
import { OUTLINE_CRITIQUE_SECTION_TITLE } from '../outlineCritique'
import { buildLengthPlan } from '../scriptLength'
import { parseOutline } from '../conversationDocument'
import { projectConversation } from '../scriptProjection'
import { SECTION_MAX_WORDS } from '../sectionQuality'
import { rawConversationReducer } from '../../reducers/rawConversationReducer'
import type { RawConversationState, RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, ReviewReport, ChatMessage, Generation } from '../../types/conversation'
import type { ExampleScript } from '../exampleSearchService'
import type { ProviderCallOptions } from '../scriptGenerationService'
import type { Script } from '../../types/script'

// Sociable integration test for the style-review pass (story 8.5): the real
// orchestrator and reducer, with the mock provider's streaming delays zeroed

const createInstantMockService = (): MockAPIService => {
  const service = new MockAPIService()
  ;(service as unknown as { delay: () => Promise<void> }).delay = async () => {}
  return service
}

interface SentRequest {
  label: string
  messages: ChatMessage[]
}

interface Harness {
  orchestrator: RawScriptGenerationOrchestrator
  conversation: RawConversation
  getState: () => RawConversationState
  actions: RawConversationAction[]
  scriptUpdates: Partial<Script>[]
  sent: SentRequest[]
}

const createHarness = (
  reviewPassEnabled: boolean,
  examples: ExampleScript[] = []
): Harness => {
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
  const sent: SentRequest[] = []

  const callbacks: RawGenerationCallbacks = {
    dispatch: (action) => {
      actions.push(action)
      state = rawConversationReducer(state, action)
    },
    appDispatch: (action) => {
      scriptUpdates.push(action.updates)
    },
    saveConversation: () => {},
    getConversation: (conversationId) =>
      state.conversations.find(c => c.id === conversationId)
  }

  // The real mock provider, with every request it is handed recorded so a
  // test can assert on exactly what the provider would receive
  const provider = createInstantMockService()
  const scriptService = {
    // Everything the orchestrator sends is passed straight through, tools
    // included: a harness that quietly dropped them would leave the whole
    // suite exercising the prose fallback while claiming to cover a run
    generateScript: (
      request: Parameters<MockAPIService['generateScript']>[0],
      messages?: ChatMessage[],
      exampleScripts?: ExampleScript[],
      abortSignal?: AbortSignal,
      options?: ProviderCallOptions
    ) => {
      sent.push({ label: 'outline', messages: messages ?? [] })
      return provider.generateScript(request, messages, exampleScripts, abortSignal, options)
    },
    regenerateSection: (
      request: Parameters<MockAPIService['regenerateSection']>[0],
      messages: ChatMessage[],
      abortSignal?: AbortSignal,
      options?: ProviderCallOptions
    ) => {
      sent.push({ label: request.sectionTitle, messages })
      return provider.regenerateSection(request, messages, abortSignal, options)
    }
  }

  const orchestrator = new RawScriptGenerationOrchestrator(
    {
      scriptService,
      exampleService: { searchExamples: async () => examples }
    },
    callbacks,
    { reviewPassEnabled }
  )

  return { orchestrator, conversation, getState: () => state, actions, scriptUpdates, sent }
}

// Selectors, not positions. A run's generation count is no longer fixed: a
// section written by tool call can be rejected and rewritten, which inserts
// generations before every later one. Each of these picks a generation out by
// what it IS — the request it carries or the reply it holds — so the
// assertions keep meaning what they meant when they were written.
const lastMessageOf = (generation: Generation): string =>
  generation.messages[generation.messages.length - 1]?.content ?? ''

const firstMessageOf = (generation: Generation): string =>
  generation.messages[0]?.content ?? ''

// The generations that wrote a given section during the run, in order. A
// rejected attempt is one of these too, which is what makes the count
// meaningful. A later rewrite is not: only a run's own section request carries
// the outline and the script-so-far, which is what distinguishes writing a
// section from revising one.
const writingGenerations = (generations: Generation[], sectionTitle: string): Generation[] =>
  generations.filter(generation =>
    lastMessageOf(generation).includes('Here is the outline for the full script:')
    && lastMessageOf(generation).includes(`"${sectionTitle}" section`))

const outlineCritiqueGeneration = (generations: Generation[]): Generation | undefined =>
  generations.find(generation => firstMessageOf(generation).includes('Here is the outline to review:'))

const styleCritiqueGeneration = (generations: Generation[]): Generation | undefined =>
  generations.find(generation => generation.response.includes('VERDICT:')
    && firstMessageOf(generation).includes('Here is the script to review:')
    && !firstMessageOf(generation).includes('The brief was:'))

const scriptReviewGeneration = (generations: Generation[]): Generation | undefined =>
  generations.find(generation => firstMessageOf(generation).includes('The brief was:'))

// Each review pass dispatches its report, so the number of rewrites a test
// provoked can be counted off the run instead of written down as a literal
const revisionsReported = (actions: RawConversationAction[]): number =>
  actions.reduce(
    (total, action) =>
      action.type === 'REVIEW_PASS_COMPLETED' ? total + action.report.revised.length : total,
    0
  )

const findGeneration = (generations: Generation[], phrase: string): Generation | undefined =>
  generations.find(generation =>
    firstMessageOf(generation).includes(phrase) || lastMessageOf(generation).includes(phrase))

describe('style-review pass integration', () => {
  it('critiques the finished script, revises violating sections and reports the outcome', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, actions, scriptUpdates } = createHarness(true)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    // The critique exchange is stored as a generation of its own
    const finalConversation = getState().conversations[0]
    const critiqueGeneration = styleCritiqueGeneration(finalConversation.generations)
    expect(critiqueGeneration).toBeDefined()

    // The mock critique flags two sections, both revised via regeneration
    const report = getState().reviewReport as ReviewReport
    expect(report).not.toBeNull()
    expect(report.conversationId).toBe(conversation.id)
    expect(report.revised).toHaveLength(2)
    expect(report.revised.map(entry => entry.ruleNumbers)).toEqual([[6], [9]])

    // Outline + outline critique + one generation per planned section + style
    // critique + one revision per flagged section, and nothing else. The total
    // is derived from the run rather than written down, because a rejection
    // loop moves it; nothing in this run provokes a rejection, so each section
    // must be written exactly once and the total must come out exactly.
    const critique = outlineCritiqueGeneration(finalConversation.generations)
    expect(critique).toBeDefined()
    const planned = parseOutline((critique as Generation).response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(finalConversation.generations, section.title)).toHaveLength(1)
    }
    expect(finalConversation.generations)
      .toHaveLength(1 + 1 + planned.length + 1 + report.revised.length)

    // The revision prompts carry the violation as an instruction
    const revisionGeneration = findGeneration(finalConversation.generations, 'A style review found')
    expect(revisionGeneration).toBeDefined()
    const revisionPrompt = lastMessageOf(revisionGeneration as Generation)
    expect(revisionPrompt).toContain('A style review found')
    expect(revisionPrompt).toContain('style rule 6')

    // The generation still completes normally
    expect(scriptUpdates.some(update => update.status === 'complete')).toBe(true)
    expect(getState().generationMachine?.phase).toBe('complete')
    expect(actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(true)

    vi.restoreAllMocks()
  }, 30000)

  it('does not run the review pass when disabled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, actions } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    // The outline and exactly one generation per planned section: no critique
    // of either, no report, and — since nothing here provokes a rejection —
    // no other generation at all
    const generations = getState().conversations[0].generations
    expect(outlineCritiqueGeneration(generations)).toBeUndefined()
    expect(styleCritiqueGeneration(generations)).toBeUndefined()
    const planned = parseOutline(generations[0].response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(generations, section.title)).toHaveLength(1)
    }
    expect(generations).toHaveLength(1 + planned.length)
    expect(getState().reviewReport).toBeNull()
    expect(actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(false)

    vi.restoreAllMocks()
  }, 30000)
})

describe('on-demand whole-script review (story 8.14)', () => {
  it('reviews the finished script for cohesion and length, then rewrites what it flags', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, actions, scriptUpdates } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    // The outline and one generation per planned section are written, nothing
    // else is, and nothing has reviewed them
    const written = getState().conversations[0].generations
    expect(scriptReviewGeneration(written)).toBeUndefined()
    expect(getState().reviewReport).toBeNull()
    const planned = parseOutline(written[0].response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(written, section.title)).toHaveLength(1)
    }
    expect(written).toHaveLength(1 + planned.length)

    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')

    const generations = getState().conversations[0].generations
    const reviewGeneration = scriptReviewGeneration(generations) as Generation
    expect(reviewGeneration).toBeDefined()

    // The review request states the brief and the measured length as fact
    const reviewPrompt = reviewGeneration.messages[0].content
    expect(reviewPrompt).toContain('a relaxing script')
    expect(reviewPrompt).toContain(`about ${buildLengthPlan().targetMinutes} minutes`)
    expect(reviewPrompt).toContain('The length is on target.')
    expect(reviewGeneration.response).toContain('VERDICT:')

    // A mock run lands inside the duration window, so only the section the
    // review flags for cohesion is rewritten
    const report = getState().reviewReport as ReviewReport
    expect(report.conversationId).toBe(conversation.id)
    expect(report.revised).toHaveLength(1)
    expect(report.revised[0].reason).toBe('cohesion')
    expect(report.summary).toContain('rewrote 1 section')
    expect(report.summary).toContain(`close to the ${buildLengthPlan().targetMinutes} minute target`)

    // The review adds its own exchange and one rewrite per flagged section on
    // top of what the run had already written, and nothing besides
    expect(generations).toHaveLength(1 + planned.length + 1 + report.revised.length)

    // The rewrite carries the cohesion problem as its instruction
    const revision = findGeneration(generations, 'does not sit right in the arc') as Generation
    expect(revision).toBeDefined()
    const revisionPrompt = lastMessageOf(revision)
    expect(revisionPrompt).toContain('does not sit right in the arc')
    expect(revisionPrompt).toContain('Re-inducts a listener who is already deep')

    // The rewritten script is saved, and the run settles as complete
    const lastUpdate = scriptUpdates[scriptUpdates.length - 1]
    expect(lastUpdate.status).toBe('complete')
    expect(lastUpdate.content).toContain('## Awakening')
    expect(getState().generationMachine?.phase).toBe('complete')
    expect(getState().currentGeneration?.isComplete).toBe(true)
    expect(actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(true)

    vi.restoreAllMocks()
  }, 30000)

  it('grows the sections with the most room when the script is under its duration target', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, scriptUpdates } = createHarness(false)

    // A finished but far too short script: an outline plus three thin sections
    const short = (label: string, wordCount: number) =>
      `## ${label}\n` + Array.from({ length: wordCount }, (_, i) => `word${i}`).join(' ')
    const stored = {
      ...conversation,
      generations: [
        {
          messages: [],
          response: '# Deep Rest\n## Induction\nSettle.\n## Deepening\nDescend.\n## Awakening\nReturn.',
          timestamp: 0
        },
        { messages: [], response: short('Induction', 200), timestamp: 0 },
        { messages: [], response: short('Deepening', 150), timestamp: 0 },
        { messages: [], response: short('Awakening', 100), timestamp: 0 }
      ]
    }
    getState().conversations[0] = stored

    await orchestrator.reviewScript(stored, 'a relaxing script')

    const generations = getState().conversations[0].generations
    expect(firstMessageOf(scriptReviewGeneration(generations) as Generation)).toContain('words short')

    // Every rewrite slot is used, each with an explicit word target, and the
    // section the review flagged also carries its cohesion problem
    const report = getState().reviewReport as ReviewReport
    expect(report.revised).toHaveLength(MAX_SCRIPT_REVIEW_REVISIONS)
    expect(report.revised.map(entry => entry.reason)).toContain('cohesion and length')
    expect(report.summary).toContain(`under the ${buildLengthPlan().targetMinutes} minute target`)

    // The review exchange plus one rewrite per slot, on top of the four
    // generations the stored conversation already held
    expect(generations).toHaveLength(stored.generations.length + 1 + report.revised.length)

    // Each rewrite states the section's measured length and asks for more than
    // it has. Selecting the prompts by the growth instruction and then merely
    // re-matching that instruction would assert nothing, so the numbers the
    // instructions carry are what is checked: every target above its current
    // count, and the current counts exactly the lengths of the thin sections
    // as the document measures them.
    const growth = /expand this section from (\d+) to approximately (\d+) words/
    const growthPrompts = generations.map(lastMessageOf).filter(prompt => growth.test(prompt))
    expect(growthPrompts).toHaveLength(MAX_SCRIPT_REVIEW_REVISIONS)
    const currents: number[] = []
    for (const prompt of growthPrompts) {
      const [, current, target] = prompt.match(growth) as RegExpMatchArray
      expect(Number(target)).toBeGreaterThan(Number(current))
      currents.push(Number(current))
    }
    const measured = projectConversation(stored).sections.map(section => section.wordCount)
    expect([...currents].sort((a, b) => a - b)).toEqual([...measured].sort((a, b) => a - b))

    // The grown script is what gets saved
    expect(scriptUpdates[scriptUpdates.length - 1].status).toBe('complete')

    vi.restoreAllMocks()
  }, 30000)

  it('reports a failed review instead of swallowing it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(false)

    await expect(orchestrator.reviewScript(conversation, 'a relaxing script')).rejects.toThrow(
      /no outline/i
    )
    expect(getState().reviewReport).toBeNull()

    vi.restoreAllMocks()
  })
})

// The review judges length and instructs rewrites against a target, so a
// review that replans at the default would cut a correctly sized long script
describe('the whole-script review honours the run length', () => {
  it('judges and rewrites against the requested length, not the default', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id, targetMinutes: 60 },
      conversation
    )

    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script', 60)

    const generations = getState().conversations[0].generations
    const review = scriptReviewGeneration(generations)
    expect(review).toBeDefined()
    const reviewPrompt = firstMessageOf(review as Generation)
    expect(reviewPrompt).toContain('VERDICT')

    expect(reviewPrompt).toContain('60 minutes')
    expect(reviewPrompt).not.toContain(`${buildLengthPlan().targetMinutes} minutes`)
  })
})

describe('outline-critique step integration (story 8.9)', () => {
  const revisedDescription =
    "Deepen the listener's trance while gradually escalating intensity toward the transformation ahead."

  it('critiques the outline and the revised outline replaces generation 0 as the plan', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(true)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    const generations = getState().conversations[0].generations

    // The critique exchange is stored as the revised outline
    const critiqueGeneration = outlineCritiqueGeneration(generations) as Generation
    expect(critiqueGeneration).toBeDefined()
    expect(critiqueGeneration.messages[0].content).toContain('Here is the outline to review:')
    expect(critiqueGeneration.response.startsWith('# ')).toBe(true)
    expect(critiqueGeneration.response).toContain(revisedDescription)

    // Every section request inherits the revised outline, not the original
    const planned = parseOutline(critiqueGeneration.response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(generations, section.title)).toHaveLength(1)
    }
    const sectionGenerations = planned.flatMap(
      section => writingGenerations(generations, section.title)
    )
    for (const generation of sectionGenerations) {
      expect(lastMessageOf(generation)).toContain(revisedDescription)
    }

    // Outline + critique + one write per revised section + style critique +
    // one rewrite per flagged section: no section was written twice, and no
    // generation was written against the outline the critique replaced
    const report = getState().reviewReport as ReviewReport
    expect(generations).toHaveLength(1 + 1 + planned.length + 1 + report.revised.length)

    vi.restoreAllMocks()
  }, 30000)

  it('holds the critique to the run length plan rather than a fixed section count', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(true)
    const plan = buildLengthPlan(45)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id, targetMinutes: 45 },
      conversation
    )

    const critiquePrompt = firstMessageOf(
      outlineCritiqueGeneration(getState().conversations[0].generations) as Generation
    )
    expect(critiquePrompt).toContain(`about ${plan.sectionCount} \`## Section Title\` headers`)
    expect(critiquePrompt).toContain(`roughly ${plan.sectionWords} words`)
    expect(critiquePrompt).not.toContain('exactly 5 `## Section Title`')

    vi.restoreAllMocks()
  }, 30000)

  it('gives each section the outline entries of upcoming sections (story 8.10)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    const generations = getState().conversations[0].generations
    const planned = parseOutline(generations[0].response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(generations, section.title)).toHaveLength(1)
    }
    expect(generations).toHaveLength(1 + planned.length)
    const sectionGenerations = planned.map(
      section => writingGenerations(generations, section.title)[0]
    )

    // Every section but the last names what is still to come
    for (let i = 0; i < sectionGenerations.length; i++) {
      const generation = sectionGenerations[i]
      const userMessage = lastMessageOf(generation)

      if (i < sectionGenerations.length - 1) {
        expect(userMessage).toContain('Still to come after this section')
        // The mock outline for this prompt ends with the Awakening section
        expect(userMessage).toContain('- "Awakening":')
      } else {
        expect(userMessage).not.toContain('Still to come after this section')
      }
    }

    vi.restoreAllMocks()
  }, 30000)
})

// End-to-end coverage of the rejection loop through the real mock provider,
// which is the provider a keyless install actually runs on
describe('the rejection loop against the mock provider', () => {
  it('rejects an over-length section, asks again, and finishes the script on the rewrite', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, scriptUpdates } = createHarness(false)

    await orchestrator.generateScript(
      {
        prompt: `a relaxing script ${MockAPIService.OVERLONG_SECTION_MARKER}`,
        conversationId: conversation.id
      },
      conversation
    )

    const generations = getState().conversations[0].generations
    const calls = generations.flatMap(generation => generation.toolCalls ?? [])
    const rejected = calls.filter(call => call.status === 'rejected')
    expect(rejected[0].reason).toContain('REJECTED')

    // Every planned section still ends up accepted, each on its second attempt
    const outline = parseOutline(generations[0].response)
    const planned = outline?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(generations, section.title)).toHaveLength(2)
      const statuses = calls.filter(call => call.title === section.title).map(call => call.status)
      expect(statuses).toEqual(['rejected', 'accepted'])
    }

    // One rejection per section and no third attempt anywhere: the total is
    // the outline plus the two attempts each section took
    expect(rejected).toHaveLength(planned.length)
    expect(generations).toHaveLength(1 + 2 * planned.length)

    // The document holds the accepted bodies only, and the run completes
    const document = projectConversation(getState().conversations[0])
    expect(document.sections.map(section => section.title))
      .toEqual((outline?.sections ?? []).map(section => section.title))
    for (const section of document.sections) {
      expect(section.wordCount).toBeLessThanOrEqual(SECTION_MAX_WORDS)
    }
    expect(scriptUpdates[scriptUpdates.length - 1].status).toBe('complete')

    vi.restoreAllMocks()
  }, 30000)
})

describe('which requests the exemplars ride on', () => {
  const exampleContent = 'A candle gutters in still air, and the flame steadies again.'
  const example: ExampleScript = {
    content: exampleContent,
    metadata: { id: 'ex-candle', title: 'Candle Flame', source: 'bundled', tags: 'calm' },
    score: 0.9
  }

  const judgingTitles = [
    OUTLINE_CRITIQUE_SECTION_TITLE,
    STYLE_REVIEW_SECTION_TITLE,
    SCRIPT_REVIEW_SECTION_TITLE
  ]

  const carriesExample = (messages: ChatMessage[]) =>
    messages.some(message => message.content.includes(exampleContent))

  it('grounds prose requests in the exemplars and leaves the judging passes without them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, actions, sent } = createHarness(true, [example])

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )
    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')

    const judging = sent.filter(request => judgingTitles.includes(request.label))
    expect(judging.map(request => request.label)).toEqual(judgingTitles)
    for (const request of judging) {
      expect(carriesExample(request.messages)).toBe(false)
    }

    // Every prose request — the outline, each section and each review-driven
    // rewrite — carries the corpus, and there are exactly that many of them:
    // an equality, so an ungrounded extra request cannot hide inside a count
    // that only had to be large enough
    const generations = getState().conversations[0].generations
    const critique = outlineCritiqueGeneration(generations) as Generation
    const planned = parseOutline(critique.response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    const prose = sent.filter(request => !judgingTitles.includes(request.label))
    expect(prose).toHaveLength(1 + planned.length + revisionsReported(actions))
    for (const request of prose) {
      expect(carriesExample(request.messages)).toBe(true)
    }

    // Nothing was sent that the conversation does not hold a generation for
    expect(sent).toHaveLength(generations.length)

    vi.restoreAllMocks()
  }, 30000)
})
