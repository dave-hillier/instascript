import { describe, it, expect, vi } from 'vitest'
import { RawScriptGenerationOrchestrator } from '../rawScriptGenerationOrchestrator'
import type { RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import { MockAPIService } from '../mockApi'
import { SCRIPT_REVIEW_SECTION_TITLE } from '../scriptReview'
import { STYLE_REVIEW_SECTION_TITLE } from '../critiquePass'
import { OUTLINE_CRITIQUE_SECTION_TITLE } from '../outlineCritique'
import { buildLengthPlan } from '../scriptLength'
import { parseOutline, consolidateSections } from '../conversationDocument'
import { projectConversation } from '../scriptProjection'
import {
  parseConversationFromYamlMarkdown,
  serializeConversationToYamlMarkdown
} from '../conversationParser'
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

// Neither judging pass rewrites anything any more, so the harness has no
// rewrite reply to script: every request it answers is one the run itself
// asked for, straight from the mock provider.
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

const findGeneration = (generations: Generation[], phrase: string): Generation | undefined =>
  generations.find(generation =>
    firstMessageOf(generation).includes(phrase) || lastMessageOf(generation).includes(phrase))

describe('style-review pass integration', () => {
  it('critiques the finished script, MARKS what it finds, and rewrites nothing', async () => {
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

    // The mock critique flags two sections. They are MARKED, not rewritten:
    // the report names them and the script is left exactly as it was written.
    const report = getState().reviewReport as ReviewReport
    expect(report).not.toBeNull()
    expect(report.conversationId).toBe(conversation.id)
    expect(report.revised).toHaveLength(2)
    expect(report.revised.map(entry => entry.ruleNumbers)).toEqual([[6], [9]])

    // Outline + outline critique + one generation per planned section + the
    // style critique, and nothing else. The count is the assertion that the
    // pass stopped rewriting: the old loop added one regeneration per flagged
    // section, so a rewrite here would show up as two extra generations.
    const critique = outlineCritiqueGeneration(finalConversation.generations)
    expect(critique).toBeDefined()
    const planned = parseOutline((critique as Generation).response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    for (const section of planned) {
      expect(writingGenerations(finalConversation.generations, section.title)).toHaveLength(1)
    }
    expect(finalConversation.generations).toHaveLength(1 + 1 + planned.length + 1)

    // No section was asked to rewrite itself for a style finding
    expect(findGeneration(finalConversation.generations, 'A style review found')).toBeUndefined()

    // And the marks reach the reading view. A pass whose findings only ever
    // existed inside the function that made them would leave this empty, and
    // the reader would be shown a script nothing had ever judged.
    const projected = projectConversation(finalConversation)
    expect(projected.findings).toEqual([
      { stage: 'style', section: report.revised[0].sectionTitle, rules: [6], reason: report.revised[0].reason },
      { stage: 'style', section: report.revised[1].sectionTitle, rules: [9], reason: report.revised[1].reason }
    ])
    // A prose critique quotes no passage — a VERDICT line names a section and
    // a rule and points at nothing — so no span is invented for it
    expect(projected.findings?.every(finding => finding.spans === undefined)).toBe(true)

    // and they are still there when the conversation is read back off disk
    const reloaded = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(finalConversation)
    )
    expect(projectConversation(reloaded!).findings).toEqual(projected.findings)

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
  it('reviews the finished script for cohesion and length, MARKS what it finds, and rewrites nothing', async () => {
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

    const before = consolidateSections(getState().conversations[0])

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

    // The section the review will not call cohesive is MARKED
    const report = getState().reviewReport as ReviewReport
    expect(report.conversationId).toBe(conversation.id)
    expect(report.revised).toHaveLength(1)
    expect(report.revised[0].reason).toContain('Re-inducts a listener who is already deep')
    expect(report.summary).toContain('marked 1 section')
    expect(report.summary).toContain('Nothing was rewritten')
    expect(report.summary).toContain(`close to the ${buildLengthPlan().targetMinutes} minute target`)

    // The review adds ONE generation — its own — and no rewrite. The count is
    // the assertion that the pass stopped rewriting: the old loop added one
    // regeneration per flagged section.
    expect(generations).toHaveLength(1 + planned.length + 1)
    expect(findGeneration(generations, 'does not sit right in the arc')).toBeUndefined()

    // The script the reader had is the script the reader still has
    expect(consolidateSections(getState().conversations[0])).toEqual(before)

    // And the marks reach the reading view, stamped with the pass that made
    // them — the branch nothing could reach while the review recorded nothing
    const projected = projectConversation(getState().conversations[0])
    expect(projected.findings).toEqual([
      {
        stage: 'review',
        section: report.revised[0].sectionTitle,
        reason: report.revised[0].reason
      }
    ])
    // A prose review quotes no passage, so no span is invented for it
    expect(projected.findings?.every(finding => finding.spans === undefined)).toBe(true)

    // and they survive a round trip through storage
    const reloaded = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(getState().conversations[0])
    )
    expect(projectConversation(reloaded!).findings).toEqual(projected.findings)

    const lastUpdate = scriptUpdates[scriptUpdates.length - 1]
    expect(lastUpdate.status).toBe('complete')
    expect(lastUpdate.content).toContain('## Awakening')
    expect(getState().generationMachine?.phase).toBe('complete')
    expect(getState().currentGeneration?.isComplete).toBe(true)
    expect(actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(true)

    vi.restoreAllMocks()
  }, 30000)

  it('tells the reader a short script is short instead of padding it out for them', async () => {
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
    // The shortfall is still measured, and still stated to the model as fact
    expect(firstMessageOf(scriptReviewGeneration(generations) as Generation)).toContain('words short')

    // It is reported to the reader, and nothing is written to fix it: the
    // review exchange is the only generation the press added
    const report = getState().reviewReport as ReviewReport
    expect(report.summary).toContain(`under the ${buildLengthPlan().targetMinutes} minute target`)
    expect(report.summary).toContain('Nothing was rewritten')
    expect(generations).toHaveLength(stored.generations.length + 1)
    expect(generations.some(generation => /approximately \d+ words/.test(lastMessageOf(generation))))
      .toBe(false)

    // The thin sections are untouched
    expect(consolidateSections(getState().conversations[0]))
      .toEqual(consolidateSections(stored))
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

// The review judges length against a target, so a review that replanned at the
// default would tell the reader a correctly sized long script runs long
describe('the whole-script review honours the run length', () => {
  it('judges against the requested length, not the default', async () => {
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

    // Outline + critique + one write per revised section + style critique: no
    // section was written twice, and no generation was written against the
    // outline the critique replaced. The style pass adds nothing beyond its
    // own generation, because it marks rather than rewrites.
    expect(generations).toHaveLength(1 + 1 + planned.length + 1)

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

    // Every prose request — the outline and each section — carries the corpus,
    // and there are exactly that many of them: an equality, so an ungrounded
    // extra request cannot hide inside a count that only had to be large
    // enough. Neither judging pass writes prose any more, so nothing else is
    // sent at all.
    const generations = getState().conversations[0].generations
    const critique = outlineCritiqueGeneration(generations) as Generation
    const planned = parseOutline(critique.response)?.sections ?? []
    expect(planned.length).toBeGreaterThan(1)
    expect(actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(true)
    const prose = sent.filter(request => !judgingTitles.includes(request.label))
    expect(prose).toHaveLength(1 + planned.length)
    for (const request of prose) {
      expect(carriesExample(request.messages)).toBe(true)
    }

    // Nothing was sent that the conversation does not hold a generation for
    expect(sent).toHaveLength(generations.length)

    vi.restoreAllMocks()
  }, 30000)
})

// --- the round records a planned run leaves behind ------------------------

// Exactly what a conversation written before round records reads back as
const stripRounds = (generation: Generation): Generation => {
  const stripped = { ...generation }
  delete stripped.round
  return stripped
}

describe('a planned run records the rounds it took', () => {
  it('stamps every generation with the round that produced it, numbered from one', async () => {
    const { orchestrator, conversation, getState } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    const generations = getState().conversations[0].generations
    expect(generations.every(generation => generation.round !== undefined)).toBe(true)

    const numbers = generations.map(generation => generation.round!.round)
    expect(numbers[0]).toBe(1)
    // Never decreasing, and a section round can open more than one generation
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers)

    expect(generations[0].round).toEqual({ round: 1, kind: 'outline' })
    const planned = parseOutline(generations[0].response)?.sections ?? []
    for (let index = 0; index < planned.length; index++) {
      const section = writingGenerations(generations, planned[index].title)[0]
      expect(section.round).toMatchObject({ kind: 'section', sectionIndex: index })
    }
  })

  it('records the optional passes the pipeline asked for, in the order they ran', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(true)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    const generations = getState().conversations[0].generations
    expect(outlineCritiqueGeneration(generations)!.round!.kind).toBe('outline-critique')
    expect(styleCritiqueGeneration(generations)!.round!.kind).toBe('style-critique')

    // The kinds a whole run takes, with the repeats collapsed
    const kinds = generations
      .map(generation => generation.round!.kind)
      .filter((kind, index, all) => kind !== all[index - 1])
    expect(kinds[0]).toBe('outline')
    expect(kinds[1]).toBe('outline-critique')
    expect(kinds[2]).toBe('section')
    // The style critique is the LAST thing the run does. It used to be
    // followed by the rewrites it asked for; it marks now and stops, so
    // nothing follows it.
    expect(kinds[kinds.length - 1]).toBe('style-critique')
    expect(generations[generations.length - 1].round!.kind).toBe('style-critique')
  })

  // BLOCKER 1, in the shape the pass now has. It rewrites nothing, so the
  // failure the old test guarded against — the folds skipping the rewrites
  // along with the critique's prose — cannot happen; what CAN still happen is
  // the other half of it, a critique's own reply becoming a section of the
  // script. Both folds have to leave the script exactly as it was written.
  it('leaves the script exactly as it was written, and never folds its critique into it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, scriptUpdates } = createHarness(true)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    const generations = getState().conversations[0].generations
    const critiqueGeneration = styleCritiqueGeneration(generations) as Generation
    expect(generations[generations.length - 1]).toBe(critiqueGeneration)

    // The sections the reader sees are exactly the planned ones, each holding
    // the body its own section round wrote
    const planned = parseOutline((outlineCritiqueGeneration(generations) as Generation).response)
      ?.sections ?? []
    const projected = projectConversation(getState().conversations[0])
    expect(projected.sections.map(section => section.title))
      .toEqual(planned.map(section => section.title))
    for (const section of planned) {
      const written = writingGenerations(generations, section.title)[0]
      expect(projected.sections.find(entry => entry.title === section.title)?.content)
        .toBe(written.response.split('\n').slice(1).join('\n').trim())
    }

    // The consolidation the prompts and the export fold with agrees
    expect(consolidateSections(getState().conversations[0]).map(section => section.title))
      .toEqual(planned.map(section => section.title))

    // And nothing from the critique reached the saved script
    const saved = scriptUpdates.filter(update => update.status === 'complete').slice(-1)[0]
    expect(saved.content).not.toContain('VERDICT')

    vi.restoreAllMocks()
  }, 30000)

  // The record gate, end to end: a run resumed over a finished script must not
  // critique its style a second time, because an approving critique leaves
  // prose indistinguishable from a stage that never ran.
  it('does not critique the style again when its record is already in the conversation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = createHarness(true)

    await first.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: first.conversation.id },
      first.conversation
    )

    const written = first.getState().conversations[0].generations
    const second = createHarness(true)
    // Seeded into the harness's own state, which is what a reload leaves
    second.conversation.generations.push(...written)

    await second.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: second.conversation.id },
      second.conversation
    )

    expect(second.getState().conversations[0].generations).toHaveLength(written.length)
  })

  // The numbering continues from what is stored, so a resumed run cannot
  // re-issue a number already spent.
  it('continues the numbering a stored conversation already carries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = createHarness(false)

    await first.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: first.conversation.id },
      first.conversation
    )

    const written = first.getState().conversations[0]
    const lastRound = written.generations[written.generations.length - 1].round!.round
    // Drop the final section so the resumed run has something to plan
    const kept = written.generations.slice(0, -1)

    const second = createHarness(false)
    second.conversation.generations.push(...kept)
    await second.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: second.conversation.id },
      second.conversation
    )

    const resumedRounds = second.getState().conversations[0].generations
      .slice(kept.length)
      .map(generation => generation.round!.round)
    expect(resumedRounds.length).toBeGreaterThan(0)
    expect(Math.min(...resumedRounds)).toBeGreaterThan(lastRound - 1)
  })

  // A legacy conversation carries no round records and its optional passes may
  // well have run. Re-critiquing it on every open would be the alternative.
  it('treats a conversation written before rounds existed as already critiqued', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = createHarness(false)

    await first.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: first.conversation.id },
      first.conversation
    )

    // Exactly what an old file reads back as: prose, and not one round record
    const legacy = first.getState().conversations[0].generations.map(stripRounds)

    const second = createHarness(true)
    second.conversation.generations.push(...legacy)
    await second.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: second.conversation.id },
      second.conversation
    )

    const added = second.getState().conversations[0].generations.slice(legacy.length)
    expect(added).toHaveLength(0)
  })

  it('still resumes a half-finished legacy conversation at the right section', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = createHarness(false)

    await first.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: first.conversation.id },
      first.conversation
    )

    const written = first.getState().conversations[0].generations
    const planned = parseOutline(written[0].response)?.sections ?? []
    const half = written.slice(0, written.length - 1).map(stripRounds)

    const second = createHarness(false)
    second.conversation.generations.push(...half)
    await second.orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: second.conversation.id },
      second.conversation
    )

    const added = second.getState().conversations[0].generations.slice(half.length)
    expect(added.length).toBeGreaterThan(0)
    // It wrote sections, not another outline
    expect(added.every(generation => generation.round!.kind === 'section')).toBe(true)
    expect(writingGenerations(added, planned[planned.length - 1].title).length)
      .toBeGreaterThan(0)
  })
})

describe('the whole-script review is a command that leaves a record', () => {
  it('stamps a review round on everything the button writes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )
    const beforeReview = getState().conversations[0].generations
    const lastRound = beforeReview[beforeReview.length - 1].round!.round

    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')

    const added = getState().conversations[0].generations.slice(beforeReview.length)
    // One round number for the whole press — the record a pipeline that ever
    // switched the review on would read — on the one generation the press
    // writes. It asks for no rewrites, so there is nothing else to stamp.
    expect(added).toHaveLength(1)
    expect(added[0].round).toEqual({ round: lastRound + 1, kind: 'review' })
  })

  // BLOCKER 2. Storage and the reading view have to say the same thing about
  // what the script says: the content saved here is built from
  // consolidateSections, and the reading view folds through
  // projectConversation. A critique's own reply must not become a section of
  // the script in either of them.
  it('leaves the two folds agreeing about the reviewed script', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState, scriptUpdates } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )
    const before = consolidateSections(getState().conversations[0])
    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')

    const reviewed = getState().conversations[0]
    expect((getState().reviewReport as ReviewReport).revised.length).toBeGreaterThan(0)

    const projected = projectConversation(reviewed)
    expect(projected.sections.map(section => ({
      title: section.title,
      content: section.content
    }))).toEqual(consolidateSections(reviewed))

    // And both folds still hold exactly the script that was written: the
    // review's own VERDICT lines are a critique, not a section
    expect(consolidateSections(reviewed)).toEqual(before)
    const saved = scriptUpdates.filter(update => update.status === 'complete').slice(-1)[0]
    expect(saved.content).not.toContain('VERDICT')

    vi.restoreAllMocks()
  }, 30000)

  // It is repeatable: a record gate would forbid the reader's second press,
  // and the button is not gated by one.
  it('can be pressed again, and numbers the second pass after the first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { orchestrator, conversation, getState } = createHarness(false)

    await orchestrator.generateScript(
      { prompt: 'a relaxing script', conversationId: conversation.id },
      conversation
    )

    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')
    const afterFirst = getState().conversations[0].generations
    await orchestrator.reviewScript(getState().conversations[0], 'a relaxing script')
    const afterSecond = getState().conversations[0].generations

    expect(afterSecond.length).toBeGreaterThan(afterFirst.length)
    const rounds = afterSecond.slice(afterFirst.length).map(generation => generation.round!.round)
    expect(new Set(rounds).size).toBe(1)
    expect(rounds[0]).toBe(afterFirst[afterFirst.length - 1].round!.round + 1)
  })
})
