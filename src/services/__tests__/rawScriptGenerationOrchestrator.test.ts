import { describe, it, expect } from 'vitest'
import { findResumeState, RawScriptGenerationOrchestrator } from '../rawScriptGenerationOrchestrator'
import type { RawScriptServices, RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import type { RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, Generation } from '../../types/conversation'

const makeGeneration = (response: string): Generation => ({
  messages: [],
  response,
  timestamp: 0
})

const makeConversation = (responses: string[]): RawConversation => ({
  id: 'conv-1',
  scriptId: 'script-1',
  generations: responses.map(makeGeneration),
  createdAt: 0,
  updatedAt: 0
})

const outlineText = [
  '# Deep Rest',
  '## Induction',
  'Settle the listener with slow breathing.',
  '## Deepener',
  'Descend a staircase of ten steps.',
  '## Awakening',
  'Count back up to full alertness.'
].join('\n')

describe('findResumeState', () => {
  it('returns null for a conversation with no generations', () => {
    expect(findResumeState(makeConversation([]))).toBeNull()
  })

  it('returns null when no generation parses as an outline', () => {
    const conversation = makeConversation(['## Induction\nBreathe in slowly.'])
    expect(findResumeState(conversation)).toBeNull()
  })

  it('returns null when the outline is the last generation, since it may be truncated', () => {
    const conversation = makeConversation([outlineText])
    expect(findResumeState(conversation)).toBeNull()
  })

  it('resumes from an outline that a later generation proves complete', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nClose your eyes and breathe.'
    ])

    const resume = findResumeState(conversation)
    expect(resume).not.toBeNull()
    expect(resume?.outline.title).toBe('Deep Rest')
    expect(resume?.outline.sections.map(s => s.title)).toEqual([
      'Induction',
      'Deepener',
      'Awakening'
    ])
    expect(resume?.outlineText).toBe(outlineText)
    expect(resume?.sectionTexts.get('Induction')).toBe('Close your eyes and breathe.')
  })

  it('collects every generated section following the outline', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nClose your eyes and breathe.',
      '## Deepener\nTen steps down, one at a time.'
    ])

    const resume = findResumeState(conversation)
    expect(resume?.sectionTexts.size).toBe(2)
    expect(resume?.sectionTexts.get('Deepener')).toBe('Ten steps down, one at a time.')
  })

  it('ignores a section generation with an empty body', () => {
    const conversation = makeConversation([outlineText, '## Induction\n'])

    const resume = findResumeState(conversation)
    expect(resume).not.toBeNull()
    expect(resume?.sectionTexts.size).toBe(0)
  })

  it('uses the most recent outline when a retry produced a fresh one', () => {
    const secondOutline = [
      '# Quiet Descent',
      '## Arrival',
      'Arrive in the moment.',
      '## Return',
      'Return refreshed.'
    ].join('\n')
    const conversation = makeConversation([
      outlineText,
      '## Induction\nOld run content.',
      secondOutline,
      '## Arrival\nNew run content.'
    ])

    const resume = findResumeState(conversation)
    expect(resume?.outline.title).toBe('Quiet Descent')
    expect(resume?.sectionTexts.get('Arrival')).toBe('New run content.')
    expect(resume?.sectionTexts.has('Induction')).toBe(false)
  })
})

describe('generateScript resume (story 1.8)', () => {
  // A body comfortably inside the 250-600 word band, so no quality retry runs
  const sectionBody = (label: string) =>
    `${label} ` + Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')

  const setup = (conversation: RawConversation) => {
    let outlineCalls = 0
    const sectionCalls: string[] = []
    const dispatched: RawConversationAction[] = []
    const appDispatched: { type: string; updates: { status?: string; content?: string } }[] = []

    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => {
          outlineCalls++
          return (async function* () { yield outlineText })()
        },
        regenerateSection: (request) => {
          sectionCalls.push(request.sectionTitle)
          return (async function* () {
            yield `## ${request.sectionTitle}\n${sectionBody(request.sectionTitle)}`
          })()
        }
      },
      exampleService: {
        searchExamples: async () => []
      }
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch: action => { dispatched.push(action) },
      appDispatch: action => { appDispatched.push(action) },
      saveConversation: () => {},
      getConversation: () => conversation
    }

    return {
      orchestrator: new RawScriptGenerationOrchestrator(services, callbacks),
      state: { outlineCalls: () => outlineCalls, sectionCalls, dispatched, appDispatched }
    }
  }

  it('with the outline and N complete sections, resumes at section N+1 without regenerating the outline', async () => {
    // Induction is followed by a later generation, so it is provably complete;
    // Deepener was interrupted mid-stream and is the first incomplete section
    const conversation = makeConversation([
      outlineText,
      `## Induction\n${sectionBody('Induction')}`,
      '## Deepener\nOnly a partial line arrived before the interruption.'
    ])
    const { orchestrator, state } = setup(conversation)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    expect(state.outlineCalls()).toBe(0)
    expect(state.sectionCalls).toEqual(['Deepener', 'Awakening'])

    const completion = state.appDispatched.find(a => a.updates.status === 'complete')
    expect(completion).toBeDefined()
    // The completed Induction section is kept verbatim, not regenerated
    expect(completion?.updates.content).toContain(sectionBody('Induction'))
    expect(completion?.updates.content).toContain(sectionBody('Deepener'))
    expect(completion?.updates.content).toContain(sectionBody('Awakening'))
  })

  it('redoes the last persisted section, since without a successor it may be truncated', async () => {
    const conversation = makeConversation([
      outlineText,
      `## Induction\n${sectionBody('Induction')}`
    ])
    const { orchestrator, state } = setup(conversation)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    expect(state.outlineCalls()).toBe(0)
    expect(state.sectionCalls).toEqual(['Induction', 'Deepener', 'Awakening'])
  })

  it('regenerates everything from scratch when the request asks for a fresh start', async () => {
    const conversation = makeConversation([
      outlineText,
      `## Induction\n${sectionBody('Induction')}`,
      `## Deepener\n${sectionBody('Deepener')}`
    ])
    const { orchestrator, state } = setup(conversation)

    await orchestrator.generateScript(
      { prompt: 'A deep rest script', fresh: true },
      conversation
    )

    expect(
      state.dispatched.some(action => action.type === 'GENERATIONS_DISCARDED')
    ).toBe(true)
    expect(state.outlineCalls()).toBe(1)
    expect(state.sectionCalls).toEqual(['Induction', 'Deepener', 'Awakening'])
  })

  it('starts with the outline when there is nothing to resume', async () => {
    const conversation = makeConversation([])
    const { orchestrator, state } = setup(conversation)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    expect(state.outlineCalls()).toBe(1)
    expect(state.sectionCalls).toEqual(['Induction', 'Deepener', 'Awakening'])
    expect(
      state.dispatched.some(action => action.type === 'GENERATIONS_DISCARDED')
    ).toBe(false)
  })
})

describe('regenerateSection abort handling', () => {
  const setup = (stream: (signal?: AbortSignal) => AsyncIterable<string>) => {
    const dispatched: RawConversationAction[] = []
    const conversation = makeConversation([outlineText, '## Induction\nOld text.'])

    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => stream(),
        regenerateSection: (_request, _messages, abortSignal) => stream(abortSignal)
      },
      exampleService: {
        searchExamples: async () => []
      }
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch: action => { dispatched.push(action) },
      appDispatch: () => {},
      saveConversation: () => {},
      getConversation: () => conversation
    }

    return {
      dispatched,
      conversation,
      orchestrator: new RawScriptGenerationOrchestrator(services, callbacks)
    }
  }

  it('settles quietly without an error when the user aborts mid-stream', async () => {
    const controller = new AbortController()

    async function* abortedStream(): AsyncIterable<string> {
      yield 'A calm opening line. '
      controller.abort()
      yield 'This chunk arrives after the abort.'
    }

    const { dispatched, conversation, orchestrator } = setup(() => abortedStream())

    await expect(
      orchestrator.regenerateSection(
        { prompt: 'Rewrite it', conversationId: conversation.id, sectionTitle: 'Induction' },
        conversation,
        controller.signal
      )
    ).resolves.toBeUndefined()

    const progressActions = dispatched.filter(
      action => action.type === 'SET_GENERATION_PROGRESS'
    )
    const final = progressActions[progressActions.length - 1]
    expect(final).toMatchObject({
      isComplete: true,
      sectionTitle: 'Induction'
    })
    expect(final.type === 'SET_GENERATION_PROGRESS' && final.error).toBeUndefined()
  })

  it('still surfaces an error when the stream fails without an abort', async () => {
    async function* failingStream(): AsyncIterable<string> {
      yield 'A calm opening line. '
      throw new Error('Provider exploded')
    }

    const { dispatched, conversation, orchestrator } = setup(() => failingStream())

    await expect(
      orchestrator.regenerateSection(
        { prompt: 'Rewrite it', conversationId: conversation.id, sectionTitle: 'Induction' },
        conversation,
        new AbortController().signal
      )
    ).rejects.toThrow('Provider exploded')

    const progressActions = dispatched.filter(
      action => action.type === 'SET_GENERATION_PROGRESS'
    )
    const final = progressActions[progressActions.length - 1]
    expect(final).toMatchObject({
      isComplete: true,
      error: 'Provider exploded'
    })
  })
})
