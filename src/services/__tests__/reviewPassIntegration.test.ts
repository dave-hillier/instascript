import { describe, it, expect, vi } from 'vitest'
import { RawScriptGenerationOrchestrator } from '../rawScriptGenerationOrchestrator'
import type { RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import { MockAPIService } from '../mockApi'
import { MAX_SCRIPT_REVIEW_REVISIONS, SCRIPT_REVIEW_SECTION_TITLE } from '../scriptReview'
import { STYLE_REVIEW_SECTION_TITLE } from '../critiquePass'
import { OUTLINE_CRITIQUE_SECTION_TITLE } from '../outlineCritique'
import { buildLengthPlan } from '../scriptLength'
import { rawConversationReducer } from '../../reducers/rawConversationReducer'
import type { RawConversationState, RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, ReviewReport, ChatMessage } from '../../types/conversation'
import type { ExampleScript } from '../exampleSearchService'
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
    generateScript: (
      request: Parameters<MockAPIService['generateScript']>[0],
      messages?: ChatMessage[],
      exampleScripts?: ExampleScript[],
      abortSignal?: AbortSignal
    ) => {
      sent.push({ label: 'outline', messages: messages ?? [] })
      return provider.generateScript(request, messages, exampleScripts, abortSignal)
    },
    regenerateSection: (
      request: Parameters<MockAPIService['regenerateSection']>[0],
      messages: ChatMessage[],
      abortSignal?: AbortSignal
    ) => {
      sent.push({ label: request.sectionTitle, messages })
      return provider.regenerateSection(request, messages, abortSignal)
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
    const critiqueGeneration = finalConversation.generations.find(
      generation => generation.response.includes('VERDICT:')
    )
    expect(critiqueGeneration).toBeDefined()

    // The mock critique flags two sections, both revised via regeneration
    const report = getState().reviewReport as ReviewReport
    expect(report).not.toBeNull()
    expect(report.conversationId).toBe(conversation.id)
    expect(report.revised).toHaveLength(2)
    expect(report.revised.map(entry => entry.ruleNumbers)).toEqual([[6], [9]])

    // Outline + outline critique + 5 sections + style critique + 2 revisions
    expect(finalConversation.generations).toHaveLength(10)

    // The revision prompts carry the violation as an instruction
    const revisionGeneration = finalConversation.generations[8]
    const revisionPrompt = revisionGeneration.messages[revisionGeneration.messages.length - 1]
    expect(revisionPrompt.content).toContain('A style review found')
    expect(revisionPrompt.content).toContain('style rule 6')

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

    // Outline + 5 sections only, no critiques and no report
    expect(getState().conversations[0].generations).toHaveLength(6)
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

    // Outline + 5 mock sections, no review yet
    expect(getState().conversations[0].generations).toHaveLength(6)
    expect(getState().reviewReport).toBeNull()

    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')

    const generations = getState().conversations[0].generations
    const reviewGeneration = generations[6]

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

    // The rewrite carries the cohesion problem as its instruction
    const revisionPrompt = generations[7].messages[generations[7].messages.length - 1].content
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
    expect(generations[4].messages[0].content).toContain('words short')

    // Every rewrite slot is used, each with an explicit word target, and the
    // section the review flagged also carries its cohesion problem
    const report = getState().reviewReport as ReviewReport
    expect(report.revised).toHaveLength(MAX_SCRIPT_REVIEW_REVISIONS)
    expect(report.revised.map(entry => entry.reason)).toContain('cohesion and length')
    expect(report.summary).toContain(`under the ${buildLengthPlan().targetMinutes} minute target`)

    const revisionPrompts = generations.slice(5).map(
      generation => generation.messages[generation.messages.length - 1].content
    )
    expect(revisionPrompts).toHaveLength(MAX_SCRIPT_REVIEW_REVISIONS)
    for (const prompt of revisionPrompts) {
      expect(prompt).toMatch(/expand this section from \d+ to approximately \d+ words/)
    }

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
    const reviewPrompt = generations.find(generation =>
      generation.messages[0]?.content.includes('minutes')
      && generation.messages[0].content.includes('VERDICT')
    )?.messages[0].content ?? generations[generations.length - 2].messages[0].content

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

    // The critique exchange is generation 1, stored as the revised outline
    const critiqueGeneration = generations[1]
    expect(critiqueGeneration.messages[0].content).toContain('Here is the outline to review:')
    expect(critiqueGeneration.response.startsWith('# ')).toBe(true)
    expect(critiqueGeneration.response).toContain(revisedDescription)

    // Every section request inherits the revised outline, not the original
    const sectionGenerations = generations.slice(2, 7)
    for (const generation of sectionGenerations) {
      const userMessage = generation.messages[generation.messages.length - 1].content
      expect(userMessage).toContain(revisedDescription)
    }

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

    const critiquePrompt = getState().conversations[0].generations[1].messages[0].content
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
    const sectionGenerations = generations.slice(1)
    expect(sectionGenerations).toHaveLength(5)

    // Every section but the last names what is still to come
    for (let i = 0; i < sectionGenerations.length; i++) {
      const generation = sectionGenerations[i]
      const userMessage = generation.messages[generation.messages.length - 1].content

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
    const { orchestrator, conversation, getState, sent } = createHarness(true, [example])

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
    // rewrite — carries the corpus
    const prose = sent.filter(request => !judgingTitles.includes(request.label))
    expect(prose.length).toBeGreaterThan(5)
    for (const request of prose) {
      expect(carriesExample(request.messages)).toBe(true)
    }

    vi.restoreAllMocks()
  }, 30000)
})
