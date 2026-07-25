import { describe, it, expect, vi } from 'vitest'
import { RawScriptGenerationOrchestrator } from '../rawScriptGenerationOrchestrator'
import type { RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import { MockAPIService } from '../mockApi'
import { rawConversationReducer } from '../../reducers/rawConversationReducer'
import type { RawConversationState, RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, ReviewReport } from '../../types/conversation'
import type { Script } from '../../types/script'

// Sociable integration test for the style-review pass (story 8.5): the real
// orchestrator and reducer, with the mock provider's streaming delays zeroed

const createInstantMockService = (): MockAPIService => {
  const service = new MockAPIService()
  ;(service as unknown as { delay: () => Promise<void> }).delay = async () => {}
  return service
}

interface Harness {
  orchestrator: RawScriptGenerationOrchestrator
  conversation: RawConversation
  getState: () => RawConversationState
  actions: RawConversationAction[]
  scriptUpdates: Partial<Script>[]
}

const createHarness = (reviewPassEnabled: boolean): Harness => {
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

  const orchestrator = new RawScriptGenerationOrchestrator(
    {
      scriptService: createInstantMockService(),
      exampleService: { searchExamples: async () => [] }
    },
    callbacks,
    { reviewPassEnabled }
  )

  return { orchestrator, conversation, getState: () => state, actions, scriptUpdates }
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

    // Outline + 5 sections + critique + 2 revisions
    expect(finalConversation.generations).toHaveLength(9)

    // The revision prompts carry the violation as an instruction
    const revisionGeneration = finalConversation.generations[7]
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

    // Outline + 5 sections only, no critique and no report
    expect(getState().conversations[0].generations).toHaveLength(6)
    expect(getState().reviewReport).toBeNull()
    expect(actions.some(action => action.type === 'REVIEW_PASS_COMPLETED')).toBe(false)

    vi.restoreAllMocks()
  }, 30000)
})
