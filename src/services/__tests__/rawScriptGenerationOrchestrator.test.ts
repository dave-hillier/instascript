import { describe, it, expect } from 'vitest'
import { findResumeState, RawScriptGenerationOrchestrator } from '../rawScriptGenerationOrchestrator'
import type { RawScriptServices, RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import type { RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, Generation, ChatMessage } from '../../types/conversation'
import type { ExampleScript } from '../exampleSearchService'
import { SECTION_TARGET_WORDS } from '../sectionQuality'
import { getOutlineGenerationPrompt, getSystemPrompt, buildStructureBlock } from '../prompts'
import { buildScriptFs } from '../scriptFs'

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
  // A body at the section word target, so no quality retry runs
  const sectionBody = (label: string) =>
    `${label} ` + Array.from({ length: SECTION_TARGET_WORDS - 1 }, (_, i) => `word${i}`).join(' ')

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

describe('examples reach every request that writes prose', () => {
  const exampleContent = 'A candle gutters in still air, and the flame steadies again.'

  const example: ExampleScript = {
    content: exampleContent,
    metadata: { id: 'ex-candle', title: 'Candle Flame', source: 'bundled', tags: 'calm' },
    score: 0.9
  }

  const sectionBody = (label: string, wordCount = SECTION_TARGET_WORDS) =>
    `${label} ` + Array.from({ length: wordCount - 1 }, (_, i) => `word${i}`).join(' ')

  interface SentRequest {
    label: string
    messages: ChatMessage[]
  }

  const setup = (
    conversation: RawConversation,
    sectionText: (title: string, attempt: number) => string = title => sectionBody(title)
  ) => {
    const sent: SentRequest[] = []
    const dispatched: RawConversationAction[] = []
    const attempts = new Map<string, number>()

    const services: RawScriptServices = {
      scriptService: {
        generateScript: (_request, messages) => {
          sent.push({ label: 'outline', messages: messages ?? [] })
          return (async function* () { yield outlineText })()
        },
        regenerateSection: (request, messages) => {
          sent.push({ label: request.sectionTitle, messages })
          const attempt = (attempts.get(request.sectionTitle) ?? 0) + 1
          attempts.set(request.sectionTitle, attempt)
          return (async function* () {
            yield `## ${request.sectionTitle}\n${sectionText(request.sectionTitle, attempt)}`
          })()
        }
      },
      exampleService: {
        searchExamples: async () => [example]
      }
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch: action => { dispatched.push(action) },
      appDispatch: () => {},
      saveConversation: () => {},
      getConversation: () => conversation
    }

    return {
      orchestrator: new RawScriptGenerationOrchestrator(services, callbacks),
      sent,
      dispatched
    }
  }

  const systemOf = (request: SentRequest): string =>
    request.messages.find(message => message.role === 'system')?.content ?? ''

  it('sends the retrieved examples with every section request, not just the outline', async () => {
    const conversation = makeConversation([])
    const { orchestrator, sent } = setup(conversation)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    const sectionRequests = sent.filter(request => request.label !== 'outline')
    expect(sectionRequests.map(request => request.label)).toEqual([
      'Induction',
      'Deepener',
      'Awakening'
    ])

    for (const request of sectionRequests) {
      expect(systemOf(request)).toContain('## Examples')
      expect(systemOf(request)).toContain(exampleContent)
    }
  })

  it('sends a byte-identical system message on the outline and every section', async () => {
    const conversation = makeConversation([])
    const { orchestrator, sent } = setup(conversation)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    const systems = new Set(sent.map(systemOf))
    expect(systems.size).toBe(1)
    expect([...systems][0]).toContain(exampleContent)
  })

  it('carries the examples into a corrective retry of an under-length section', async () => {
    const conversation = makeConversation([])
    // Induction comes back far too short on its first attempt, so it is retried
    const { orchestrator, sent } = setup(conversation, (title, attempt) =>
      title === 'Induction' && attempt === 1 ? sectionBody(title, 50) : sectionBody(title)
    )

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    const inductionRequests = sent.filter(request => request.label === 'Induction')
    expect(inductionRequests).toHaveLength(2)
    const retry = inductionRequests[1]
    expect(retry.messages[retry.messages.length - 1].content).toContain('which is too short')
    expect(systemOf(retry)).toContain(exampleContent)
  })

  it('sends the examples without storing them on the conversation', async () => {
    const conversation = makeConversation([])
    const { orchestrator, dispatched } = setup(conversation)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation)

    const started = dispatched.filter(action => action.type === 'START_GENERATION')
    expect(started.length).toBeGreaterThan(0)
    for (const action of started) {
      const stored = action.type === 'START_GENERATION' ? action.messages : []
      expect(stored.some(message => message.content.includes(exampleContent))).toBe(false)
    }
  })

  it('grounds a manual section regeneration in the examples too', async () => {
    // A stored conversation whose generations carry a lean system message,
    // as replayed history does after a reload
    const conversation: RawConversation = {
      id: 'conv-1',
      scriptId: 'script-1',
      generations: [
        {
          messages: [
            { role: 'system', content: 'You are a hypnosis script writer.' },
            { role: 'user', content: 'A deep rest script' }
          ],
          response: outlineText,
          timestamp: 0
        },
        {
          messages: [{ role: 'user', content: 'Write the Induction' }],
          response: '## Induction\nOld induction text.',
          timestamp: 1
        }
      ],
      createdAt: 0,
      updatedAt: 0
    }
    const { orchestrator, sent } = setup(conversation)

    await orchestrator.regenerateSection(
      { prompt: 'Rewrite the Induction', conversationId: conversation.id, sectionTitle: 'Induction' },
      conversation
    )

    expect(sent).toHaveLength(1)
    const systemMessages = sent[0].messages.filter(message => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].content).toContain(exampleContent)
  })

  // A conversation restored from storage keeps only its user and assistant
  // turns, so there is no system message to swap the corpus into
  const reloadedConversation = (): RawConversation => ({
    id: 'conv-1',
    scriptId: 'script-1',
    generations: [
      {
        // The stored outline turn is the brief with the outline-generation
        // template appended, which is what the serializer round-trips
        messages: [{
          role: 'user',
          content: `A deep rest script\n\n${getOutlineGenerationPrompt()}`
        }],
        response: outlineText,
        timestamp: 0
      },
      {
        messages: [{ role: 'user', content: 'Write the Induction' }],
        response: '## Induction\nOld induction text.',
        timestamp: 1
      }
    ],
    createdAt: 0,
    updatedAt: 0
  })

  it('grounds a rewrite of a conversation reloaded from storage', async () => {
    const conversation = reloadedConversation()
    const { orchestrator, sent } = setup(conversation)

    await orchestrator.regenerateSection(
      { prompt: 'Rewrite the Induction', conversationId: conversation.id, sectionTitle: 'Induction' },
      conversation
    )

    const systemMessages = sent[0].messages.filter(message => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].content).toContain(exampleContent)
  })

  it('rewrites a section against the length the script was generated for', async () => {
    const conversation = reloadedConversation()
    const { orchestrator, sent } = setup(conversation)

    await orchestrator.regenerateSection(
      {
        prompt: 'Rewrite the Induction',
        conversationId: conversation.id,
        sectionTitle: 'Induction',
        targetMinutes: 60
      },
      conversation
    )

    expect(systemOf(sent[0])).toContain('60 minutes')
    expect(systemOf(sent[0])).not.toContain('25 minutes')
  })

  it('refines a whole script against the length it was generated for', async () => {
    const conversation = reloadedConversation()
    const { orchestrator, sent } = setup(conversation)

    await orchestrator.refineScript(
      { prompt: 'Make it warmer', conversationId: conversation.id, targetMinutes: 60 },
      conversation
    )

    expect(systemOf(sent[0])).toContain('60 minutes')
    expect(systemOf(sent[0])).not.toContain('25 minutes')
  })

  it('ranks the corpus against the brief rather than the rewrite boilerplate', async () => {
    const conversation = reloadedConversation()
    const queries: string[] = []
    const { orchestrator } = setup(conversation)
    // Re-wire retrieval so the query itself can be observed
    const services = (orchestrator as unknown as {
      services: { exampleService: { searchExamples: (query: string) => Promise<ExampleScript[]> } }
    }).services
    services.exampleService.searchExamples = async (query: string) => {
      queries.push(query)
      return [example]
    }

    await orchestrator.regenerateSection(
      {
        prompt: 'Rewrite the "Induction" section of the script below.',
        conversationId: conversation.id,
        sectionTitle: 'Induction',
        brief: 'A deep rest script'
      },
      conversation
    )

    expect(queries).toEqual(['A deep rest script'])
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

describe('the script structure reaches the rewrite and refinement requests', () => {
  const conversation = (): RawConversation => ({
    id: 'conv-1',
    scriptId: 'script-1',
    generations: [
      { messages: [{ role: 'user', content: 'A deep rest script' }], response: outlineText, timestamp: 0 },
      { messages: [{ role: 'user', content: 'Write the Induction' }], response: '## Induction\nOld induction text.', timestamp: 1 }
    ],
    createdAt: 0,
    updatedAt: 0
  })

  const setup = (current: RawConversation) => {
    const sent: ChatMessage[][] = []
    const dispatched: RawConversationAction[] = []

    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => (async function* () { yield outlineText })(),
        regenerateSection: (request, messages) => {
          sent.push(messages)
          return (async function* () { yield `## ${request.sectionTitle}\nNew text.` })()
        }
      },
      exampleService: { searchExamples: async () => [] }
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch: action => { dispatched.push(action) },
      appDispatch: () => {},
      saveConversation: () => {},
      getConversation: () => current
    }

    return { orchestrator: new RawScriptGenerationOrchestrator(services, callbacks), sent, dispatched }
  }

  it('appends the structure block to the last user turn of a section rewrite', async () => {
    const current = conversation()
    const { orchestrator, sent } = setup(current)

    await orchestrator.regenerateSection(
      { prompt: 'Rewrite the Induction', conversationId: current.id, sectionTitle: 'Induction' },
      current
    )

    const messages = sent[0]
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toBe(
      `Rewrite the Induction\n\n${buildStructureBlock(buildScriptFs(current))}`
    )
  })

  it('appends the structure block to the last user turn of a whole-script refinement', async () => {
    const current = conversation()
    const { orchestrator, sent } = setup(current)

    await orchestrator.refineScript(
      { prompt: 'Make it warmer', conversationId: current.id },
      current
    )

    const messages = sent[0]
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('Make it warmer')
    expect(last.content.endsWith(buildStructureBlock(buildScriptFs(current)))).toBe(true)
  })

  it('leaves the system message untouched, so the cached prefix survives', async () => {
    const current = conversation()
    const { orchestrator, sent } = setup(current)

    await orchestrator.regenerateSection(
      { prompt: 'Rewrite the Induction', conversationId: current.id, sectionTitle: 'Induction' },
      current
    )

    const systemMessages = sent[0].filter(message => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].content).toBe(getSystemPrompt())
    // Every turn before the last is history, byte-identical to what was stored
    for (const message of sent[0].slice(1, -1)) {
      expect(message.content).not.toContain('Current structure of the script')
    }
  })

  it('does not store the structure block, so it is never replayed as history', async () => {
    const current = conversation()
    const { orchestrator, dispatched } = setup(current)

    await orchestrator.regenerateSection(
      { prompt: 'Rewrite the Induction', conversationId: current.id, sectionTitle: 'Induction' },
      current
    )

    const started = dispatched.find(action => action.type === 'START_GENERATION')
    const stored = started && 'messages' in started ? started.messages ?? [] : []
    for (const message of stored) {
      expect(message.content).not.toContain('Current structure of the script')
    }
  })

  it('leaves the outline path of a full generation free of the block', async () => {
    const current = makeConversation([])
    const { orchestrator, sent } = setup(current)

    await orchestrator.generateScript({ prompt: 'A deep rest script' }, current)

    for (const messages of sent) {
      for (const message of messages) {
        expect(message.content).not.toContain('Current structure of the script')
      }
    }
  })
})
