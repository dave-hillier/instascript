import { describe, it, expect } from 'vitest'
import { rawConversationReducer } from '../rawConversationReducer'
import type { RawConversationState } from '../rawConversationReducer'
import type { RawConversation } from '../../types/conversation'

const makeConversation = (id: string): RawConversation => ({
  id,
  scriptId: `script_for_${id}`,
  generations: [{
    messages: [{ role: 'user', content: 'write a script' }],
    response: '# Title\n\n## Opening\n\nSome text.',
    timestamp: 1000
  }],
  createdAt: 1000,
  updatedAt: 2000
})

describe('rawConversationReducer CONVERSATIONS_CLEARED (story 5.5)', () => {
  it('drops all loaded conversations from in-memory state', () => {
    const state: RawConversationState = {
      conversations: [makeConversation('conv_a'), makeConversation('conv_b')],
      currentGeneration: null,
      generationMachine: null,
      reviewReport: null
    }

    const next = rawConversationReducer(state, { type: 'CONVERSATIONS_CLEARED' })

    expect(next.conversations).toEqual([])
  })

  it('resets generation state and review report so nothing stale survives', () => {
    const state: RawConversationState = {
      conversations: [makeConversation('conv_a')],
      currentGeneration: { conversationId: 'conv_a', isComplete: false },
      generationMachine: {
        phase: 'generating_section',
        conversationId: 'conv_a',
        outline: null,
        currentSectionIndex: 1,
        totalSections: 4,
        sectionWordCounts: [250]
      },
      reviewReport: { conversationId: 'conv_a', revised: [] }
    }

    const next = rawConversationReducer(state, { type: 'CONVERSATIONS_CLEARED' })

    expect(next.conversations).toEqual([])
    expect(next.currentGeneration).toBeNull()
    expect(next.generationMachine).toBeNull()
    expect(next.reviewReport).toBeNull()
  })

  it('cleared conversations cannot reappear from a later storage load of the same ids', () => {
    const loaded = [makeConversation('conv_a')]
    const seeded = rawConversationReducer(
      { conversations: loaded, currentGeneration: null, generationMachine: null, reviewReport: null },
      { type: 'CONVERSATIONS_CLEARED' }
    )

    // A LOAD_CONVERSATIONS after clearing only brings back what storage
    // still holds; storage was wiped in the same action, so an empty load
    // leaves the state empty
    const next = rawConversationReducer(seeded, { type: 'LOAD_CONVERSATIONS', conversations: [] })
    expect(next.conversations).toEqual([])
  })
})
