import { describe, it, expect } from 'vitest'
import { rawConversationReducer } from '../rawConversationReducer'
import type { RawConversationState } from '../rawConversationReducer'
import type { CritiqueRecord, RawConversation } from '../../types/conversation'

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

describe('rawConversationReducer generation tool calls', () => {
  const started = (): RawConversationState => rawConversationReducer(
    {
      conversations: [{ ...makeConversation('conv_a'), generations: [] }],
      currentGeneration: null,
      generationMachine: null,
      reviewReport: null
    },
    { type: 'START_GENERATION', conversationId: 'conv_a', messages: [{ role: 'user', content: 'write a script' }] }
  )

  const latestOf = (state: RawConversationState) => {
    const generations = state.conversations[0].generations
    return generations[generations.length - 1]
  }

  it('records tool calls on the generation in progress', () => {
    const next = rawConversationReducer(started(), {
      type: 'UPDATE_CURRENT_GENERATION',
      conversationId: 'conv_a',
      response: '## Opening\n\nSome text.',
      toolCalls: [{ id: 'call_1', name: 'section_write', title: 'Opening', status: 'accepted', wordCount: 480 }]
    })

    expect(latestOf(next).toolCalls).toEqual([
      { id: 'call_1', name: 'section_write', title: 'Opening', status: 'accepted', wordCount: 480 }
    ])
  })

  it('keeps recorded calls when a later update says nothing about them', () => {
    const withCall = rawConversationReducer(started(), {
      type: 'UPDATE_CURRENT_GENERATION',
      conversationId: 'conv_a',
      response: 'partial',
      toolCalls: [{ id: 'call_1', name: 'section_write', status: 'rejected', wordCount: 212 }]
    })

    const next = rawConversationReducer(withCall, {
      type: 'UPDATE_CURRENT_GENERATION',
      conversationId: 'conv_a',
      response: 'partial and more'
    })

    expect(latestOf(next).toolCalls).toHaveLength(1)
  })

  it('carries the final set of calls through completion', () => {
    const next = rawConversationReducer(started(), {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Opening\n\nSome text.',
      toolCalls: [
        { id: 'call_1', name: 'section_write', status: 'rejected', wordCount: 212, reason: 'under 400 words' },
        { id: 'call_2', name: 'section_write', status: 'accepted', wordCount: 512 }
      ]
    })

    expect(latestOf(next).toolCalls?.map(call => call.status)).toEqual(['rejected', 'accepted'])
  })

  it('leaves a generation that made no calls without the field', () => {
    const next = rawConversationReducer(started(), {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: 'plain prose'
    })

    expect(latestOf(next).toolCalls).toBeUndefined()
  })
})


describe('rawConversationReducer COMPLETE_GENERATION run metrics', () => {
  const openState = (): RawConversationState => ({
    conversations: [{
      id: 'conv_a',
      scriptId: 'script_a',
      generations: [{
        messages: [{ role: 'user', content: 'write a script' }],
        response: '',
        timestamp: 1000
      }],
      createdAt: 1000,
      updatedAt: 1000
    }],
    currentGeneration: null,
    generationMachine: null,
    reviewReport: null
  })

  const metrics = {
    startedAt: 1400,
    endedAt: 1500,
    firstTokenAt: 1420,
    promptTokens: 900,
    completionTokens: 120,
    cachedTokens: 768,
    finishReason: 'stop'
  }

  it('stores what the request cost on the generation it closes', () => {
    const next = rawConversationReducer(openState(), {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Induction\nBreathe.',
      metrics
    })

    expect(next.conversations[0].generations[0].metrics).toEqual(metrics)
  })

  it('fills the legacy cache count from the same reading, so the two agree', () => {
    const next = rawConversationReducer(openState(), {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Induction\nBreathe.',
      metrics
    })

    expect(next.conversations[0].generations[0].cachedTokens).toBe(768)
  })

  it('keeps the metrics already stored when a later completion carries none', () => {
    // The prose section retry rewrites an already-completed generation when
    // the FIRST attempt won. It makes no request of its own, so it must not
    // erase what the retry request cost.
    const completed = rawConversationReducer(openState(), {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Induction\nBreathe out slowly.',
      metrics
    })

    const rewritten = rawConversationReducer(completed, {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Induction\nBreathe.'
    })

    expect(rewritten.conversations[0].generations[0].response).toBe('## Induction\nBreathe.')
    expect(rewritten.conversations[0].generations[0].metrics).toEqual(metrics)
    expect(rewritten.conversations[0].generations[0].cachedTokens).toBe(768)
  })

  it('leaves a completion that measured nothing without metrics', () => {
    const next = rawConversationReducer(openState(), {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Induction\nBreathe.'
    })

    expect(next.conversations[0].generations[0].metrics).toBeUndefined()
    expect(next.conversations[0].generations[0].cachedTokens).toBeUndefined()
  })
})

describe('the round a generation belongs to', () => {
  // A conversation with no generations yet, so every index below is the
  // generation the test just opened
  const baseState = (): RawConversationState => ({
    conversations: [{ ...makeConversation('conv_a'), generations: [] }],
    currentGeneration: null,
    generationMachine: null,
    reviewReport: null
  })

  it('stamps the round the run planned onto the generation it opens', () => {
    const state = rawConversationReducer(
      baseState(),
      {
        type: 'START_GENERATION',
        conversationId: 'conv_a',
        messages: [{ role: 'user', content: 'write the induction' }],
        round: { round: 3, kind: 'section', sectionIndex: 0 }
      }
    )

    expect(state.conversations[0].generations[0].round)
      .toEqual({ round: 3, kind: 'section', sectionIndex: 0 })
  })

  // A round is fixed the moment a generation is opened, so it must NOT get
  // the accumulate-merge toolCalls gets: an inherited round number would let
  // a new generation claim the previous round's place in the plan.
  it('does not inherit the previous generation\'s round', () => {
    let state = rawConversationReducer(baseState(), {
      type: 'START_GENERATION',
      conversationId: 'conv_a',
      messages: [{ role: 'user', content: 'write the induction' }],
      round: { round: 3, kind: 'section', sectionIndex: 0 }
    })
    state = rawConversationReducer(state, {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: '## Induction\nBreathe out.'
    })
    state = rawConversationReducer(state, {
      type: 'START_GENERATION',
      conversationId: 'conv_a',
      messages: [{ role: 'user', content: 'a rewrite the reader asked for' }]
    })

    expect(state.conversations[0].generations[1].round).toBeUndefined()
  })

  it('carries the round through the streaming and closing of its generation', () => {
    let state = rawConversationReducer(baseState(), {
      type: 'START_GENERATION',
      conversationId: 'conv_a',
      messages: [{ role: 'user', content: 'critique the outline' }],
      round: { round: 2, kind: 'outline-critique' }
    })
    state = rawConversationReducer(state, {
      type: 'UPDATE_CURRENT_GENERATION',
      conversationId: 'conv_a',
      response: 'VERDICT'
    })
    state = rawConversationReducer(state, {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: 'VERDICT: APPROVED'
    })

    expect(state.conversations[0].generations[0].round)
      .toEqual({ round: 2, kind: 'outline-critique' })
  })
})

// The seam a critique reaches the application through.
describe('the critique a judging pass recorded', () => {
  // A conversation with no generations yet, so index 0 is the one the test
  // just opened
  const baseState = (): RawConversationState => ({
    conversations: [{ ...makeConversation('conv_a'), generations: [] }],
    currentGeneration: null,
    generationMachine: null,
    reviewReport: null
  })

  it('writes the critique a judging pass recorded onto the generation that closed it', () => {
    // The generation is where a critique lives: the serializer, the parser
    // and the projection's findings fold all read it from there, so a
    // completion that dropped it would leave the pass with nothing to show.
    const critique: CritiqueRecord = {
      stage: 'style',
      verdict: 'revise',
      findings: [{
        section: 'Induction',
        rules: [6],
        spans: [{ quote: 'the tide of your breath', before: '', after: '', occurrence: 0 }],
        revisions: 0,
        reason: 'Ocean imagery.'
      }]
    }

    let state = rawConversationReducer(baseState(), {
      type: 'START_GENERATION',
      conversationId: 'conv_a',
      messages: [{ role: 'user', content: 'judge the script' }]
    })
    state = rawConversationReducer(state, {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: 'The style pass marked 1 section.',
      critique
    })

    expect(state.conversations[0].generations[0].critique).toEqual(critique)
  })

  // Same rule the metrics and the tool calls beside it follow: the one
  // dispatch that rewrites an already-closed generation carries no critique,
  // and must not erase the judgement the pass recorded.
  it('keeps a recorded critique when a later completion carries none', () => {
    const critique: CritiqueRecord = { stage: 'style', verdict: 'pass', findings: [] }

    let state = rawConversationReducer(baseState(), {
      type: 'START_GENERATION',
      conversationId: 'conv_a',
      messages: [{ role: 'user', content: 'judge the script' }]
    })
    state = rawConversationReducer(state, {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: 'The style pass approved the script.',
      critique
    })
    state = rawConversationReducer(state, {
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv_a',
      response: 'The style pass approved the script.'
    })

    expect(state.conversations[0].generations[0].critique).toEqual(critique)
  })
})

describe('rawConversationReducer MODEL_THINKING_STREAMED', () => {
  const generating = (conversationId: string): RawConversationState => ({
    conversations: [makeConversation(conversationId)],
    currentGeneration: { conversationId, isComplete: false, sectionTitle: 'Opening' },
    generationMachine: null,
    reviewReport: null
  })

  it('holds the reasoning beside the step it belongs to', () => {
    const next = rawConversationReducer(generating('conv_a'), {
      type: 'MODEL_THINKING_STREAMED',
      conversationId: 'conv_a',
      thinking: 'Planning the induction'
    })

    expect(next.currentGeneration).toEqual({
      conversationId: 'conv_a',
      isComplete: false,
      sectionTitle: 'Opening',
      thinking: 'Planning the induction'
    })
  })

  // Reasoning is never part of the script: it must not reach a generation
  it('writes nothing to the conversation', () => {
    const state = generating('conv_a')
    const next = rawConversationReducer(state, {
      type: 'MODEL_THINKING_STREAMED',
      conversationId: 'conv_a',
      thinking: 'Planning the induction'
    })

    expect(next.conversations).toEqual(state.conversations)
  })

  it('ignores reasoning for a conversation that is no longer the one running', () => {
    const state = generating('conv_a')
    const next = rawConversationReducer(state, {
      type: 'MODEL_THINKING_STREAMED',
      conversationId: 'conv_b',
      thinking: 'from a step already answered'
    })

    expect(next).toBe(state)
  })

  // The step boundary is what clears it, so the reasoning of a finished
  // section never lingers over the next one
  it('is dropped when the next step reports its progress', () => {
    const withThinking = rawConversationReducer(generating('conv_a'), {
      type: 'MODEL_THINKING_STREAMED',
      conversationId: 'conv_a',
      thinking: 'Planning the induction'
    })

    const next = rawConversationReducer(withThinking, {
      type: 'SET_GENERATION_PROGRESS',
      conversationId: 'conv_a',
      isComplete: false,
      sectionTitle: 'Deepening'
    })

    expect(next.currentGeneration?.thinking).toBeUndefined()
  })
})
