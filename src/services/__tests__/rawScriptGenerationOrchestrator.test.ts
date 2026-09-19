import { describe, it, expect } from 'vitest'
import { RawScriptGenerationOrchestrator, StreamPersistence } from '../rawScriptGenerationOrchestrator'
import { projectConversation } from '../scriptProjection'
import { planNextRound, resolvePipeline } from '../roundPlan'
import type { RawScriptServices, RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'
import type { RawConversationAction } from '../../reducers/rawConversationReducer'
import type { RawConversation, Generation, ChatMessage } from '../../types/conversation'
import type { ExampleScript } from '../exampleSearchService'
import type { ProviderFrame } from '../providerFrame'
import { SECTION_TARGET_WORDS } from '../sectionQuality'
import { getOutlineGenerationPrompt, getSystemPrompt, buildStructureBlock } from '../prompts'
import { buildScriptFs } from '../scriptFs'
import { textFrames, framesFromStrings } from './fixtures/streamFake'
import { rawConversationReducer } from '../../reducers/rawConversationReducer'
import type { RawConversationState } from '../../reducers/rawConversationReducer'
import type { Script } from '../../types/script'
import { OUTLINE_CRITIQUE_SECTION_TITLE } from '../outlineCritique'
import { STYLE_REVIEW_SECTION_TITLE } from '../critiquePass'
import {
  parseConversationFromYamlMarkdown,
  serializeConversationToYamlMarkdown
} from '../conversationParser'

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

// What findResumeState used to answer, asked of what replaced it. A resume is
// no longer a special reading of the conversation: it is planNextRound over
// the ordinary projection, so these are the same cases put to the pair.
//
// One of them changes answer deliberately — see "does not redo a section that
// finished cleanly" below.
const resumePlan = (conversation: RawConversation) =>
  planNextRound(projectConversation(conversation), resolvePipeline({ reviewPass: false }))

describe('where a resumed run picks up', () => {
  it('writes an outline for a conversation with no generations', () => {
    expect(resumePlan(makeConversation([]))?.kind).toBe('outline')
  })

  it('writes an outline when nothing in the conversation parses as one', () => {
    expect(resumePlan(makeConversation(['## Induction\nBreathe in slowly.']))?.kind)
      .toBe('outline')
  })

  it('rewrites an outline that is the last generation, since it may be truncated', () => {
    expect(resumePlan(makeConversation([outlineText]))?.kind).toBe('outline')
  })

  it('resumes from an outline that a later generation proves complete', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nClose your eyes and breathe.'
    ])
    const document = projectConversation(conversation)

    expect(document.outline?.title).toBe('Deep Rest')
    expect(document.outline?.sections.map(s => s.title))
      .toEqual(['Induction', 'Deepener', 'Awakening'])
    expect(document.outlineText).toBe(outlineText)
    // The Induction body is the last generation, so it may have stopped
    // mid-sentence and is written again
    expect(resumePlan(conversation)).toEqual({ round: 1, kind: 'section', sectionIndex: 0 })
  })

  it('carries on after every section a completed generation wrote', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nClose your eyes and breathe.',
      '## Deepener\nTen steps down, one at a time.'
    ])

    expect(projectConversation(conversation).sections.map(s => s.title))
      .toEqual(['Induction', 'Deepener'])
    expect(resumePlan(conversation)).toEqual({ round: 1, kind: 'section', sectionIndex: 1 })
  })

  // The change of answer P4 asked for. The old rule redid the last written
  // section unconditionally, including after a run that finished cleanly;
  // truncationSuspect redoes it only when the body might actually be a
  // fragment, and a tool-written body never is.
  it('does not redo a section that finished cleanly, as the positional guess did', () => {
    const written = (title: string, body: string): Generation => ({
      messages: [],
      response: `## ${title}\n${body}`,
      timestamp: 0,
      toolCalls: [{ id: `call_${title}`, name: 'section_write', title, status: 'accepted', wordCount: 550 }]
    })
    const conversation: RawConversation = {
      ...makeConversation([outlineText]),
      generations: [
        makeGeneration(outlineText),
        written('Induction', 'Close your eyes.'),
        written('Deepener', 'Ten steps down.'),
        written('Awakening', 'And back into the room.')
      ]
    }

    expect(resumePlan(conversation)).toBeNull()
  })

  // The empty body is deliberately NOT the last generation: a last generation
  // is suspect anyway, so a fixture that ends on the empty heading passes
  // whether or not an empty body counts as written, and says nothing about
  // the property this test is named for.
  it('rewrites a section generation with an empty body', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\n',
      '## Deepener\nTen steps down, one at a time.'
    ])

    expect(projectConversation(conversation).sections.map(s => s.title))
      .toEqual(['Induction', 'Deepener'])
    expect(resumePlan(conversation)).toEqual({ round: 1, kind: 'section', sectionIndex: 0 })
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
    const document = projectConversation(conversation)

    expect(document.outline?.title).toBe('Quiet Descent')
    // Arrival is the last generation, so it is redone; Return has never been
    // written at all
    expect(resumePlan(conversation)).toEqual({ round: 1, kind: 'section', sectionIndex: 0 })
  })
})

// The stored-conversation contract above is markdown. This adds the one thing
// tool-call authoring changes: a generation can be a REJECTED attempt, stored
// with its body so nothing is lost, which must not come back as written.
describe('a resumed run and rejected attempts', () => {
  const rejectedSection = (title: string, body: string): Generation => ({
    messages: [],
    response: `## ${title}\n${body}`,
    timestamp: 0,
    toolCalls: [{
      id: 'call_1',
      name: 'section_write',
      title,
      status: 'rejected',
      wordCount: 40,
      reason: 'REJECTED: that body measured 40 words, which is too short.'
    }]
  })

  const acceptedSection = (title: string, body: string): Generation => ({
    messages: [],
    response: `## ${title}\n${body}`,
    timestamp: 0,
    toolCalls: [{ id: 'call_2', name: 'section_write', title, status: 'accepted', wordCount: 550 }]
  })

  it('does not restore a section the run itself rejected', () => {
    const conversation: RawConversation = {
      ...makeConversation([outlineText]),
      generations: [
        makeGeneration(outlineText),
        rejectedSection('Induction', 'A draft the run refused.'),
        acceptedSection('Deepener', 'Ten steps down.')
      ]
    }
    const document = projectConversation(conversation)

    expect(document.sections.map(s => s.title)).toEqual(['Deepener'])
    expect(resumePlan(conversation)).toEqual({ round: 1, kind: 'section', sectionIndex: 0 })
  })

  it('still restores a waived section, which was accepted out-of-window and kept', () => {
    const waived: Generation = {
      messages: [],
      response: '## Induction\nA long but kept body.',
      timestamp: 0,
      toolCalls: [{
        id: 'call_3',
        name: 'section_write',
        title: 'Induction',
        status: 'waived',
        wordCount: 900,
        reason: 'Kept at 900 words after 4 attempts.'
      }]
    }
    const conversation: RawConversation = {
      ...makeConversation([outlineText]),
      generations: [makeGeneration(outlineText), waived, acceptedSection('Deepener', 'Ten steps down.')]
    }
    const document = projectConversation(conversation)

    expect(document.sections.find(s => s.title === 'Induction')?.content)
      .toBe('A long but kept body.')
    expect(resumePlan(conversation)).toEqual({ round: 1, kind: 'section', sectionIndex: 2 })
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
          return textFrames(outlineText)
        },
        regenerateSection: (request) => {
          sectionCalls.push(request.sectionTitle)
          return textFrames(`## ${request.sectionTitle}\n${sectionBody(request.sectionTitle)}`)
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
          return textFrames(outlineText)
        },
        regenerateSection: (request, messages) => {
          sent.push({ label: request.sectionTitle, messages })
          const attempt = (attempts.get(request.sectionTitle) ?? 0) + 1
          attempts.set(request.sectionTitle, attempt)
          return textFrames(`## ${request.sectionTitle}\n${sectionText(request.sectionTitle, attempt)}`)
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
  const setup = (stream: (signal?: AbortSignal) => AsyncIterable<ProviderFrame>) => {
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

    const { dispatched, conversation, orchestrator } = setup(() => framesFromStrings(abortedStream()))

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

    const { dispatched, conversation, orchestrator } = setup(() => framesFromStrings(failingStream()))

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
        generateScript: () => textFrames(outlineText),
        regenerateSection: (request, messages) => {
          sent.push(messages)
          return textFrames(`## ${request.sectionTitle}\nNew text.`)
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

// Every turn opens its generation with START_GENERATION, which appends one
// holding an empty response. A failure path that returns without a
// COMPLETE_GENERATION leaves it that way — and the deployed parser drops a
// generation written with no response block, taking its prompt with it and
// stranding it on the generation after. These run the real reducer so the
// stored conversation is the one the save would actually write.
describe('a failed turn never leaves an open generation behind', () => {
  const sectionBody = (label: string) =>
    `${label} ` + Array.from({ length: SECTION_TARGET_WORDS - 1 }, (_, i) => `word${i}`).join(' ')

  async function* failsImmediately(): AsyncGenerator<ProviderFrame, void, unknown> {
    // The request reached the provider and then dropped: a first token, and no
    // prose behind it, so the generation is still holding an empty response
    yield { kind: 'firstToken', at: 0 }
    throw new Error('the provider connection dropped')
  }

  async function* failsPartWayThrough(): AsyncGenerator<ProviderFrame, void, unknown> {
    yield { kind: 'firstToken', at: 0 }
    yield { kind: 'text', delta: 'Breathe out, and' }
    throw new Error('the provider connection dropped')
  }

  const setup = (options: {
    conversation?: RawConversation
    sectionStream?: (sectionTitle: string) => AsyncIterable<ProviderFrame> | null
  } = {}) => {
    const conversation = options.conversation ?? {
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

    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => textFrames(outlineText),
        regenerateSection: request =>
          options.sectionStream?.(request.sectionTitle)
            ?? textFrames(`## ${request.sectionTitle}\n${sectionBody(request.sectionTitle)}`)
      },
      exampleService: { searchExamples: async () => [] }
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch: action => { state = rawConversationReducer(state, action) },
      appDispatch: () => {},
      saveConversation: () => {},
      getConversation: id => state.conversations.find(entry => entry.id === id),
      // A model with no tool calling, so the run is written as prose and the
      // critique and review turns are the ones under test
      getScript: () => ({ model: 'gpt-3.5-turbo-instruct' })
    }

    return {
      orchestrator: new RawScriptGenerationOrchestrator(services, callbacks, {
        reviewPassEnabled: true
      }),
      conversation,
      generations: () => state.conversations[0].generations
    }
  }

  it('closes the generation when the outline critique fails', async () => {
    const harness = setup({
      sectionStream: title =>
        title === OUTLINE_CRITIQUE_SECTION_TITLE ? failsImmediately() : null
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    const empty = harness.generations().filter(generation => !generation.response)
    expect(empty).toEqual([])

    const critique = harness.generations()[1]
    expect(critique.response).toBe(
      'No outline critique was written: the request ended before the model finished.'
    )
    // A failed critique never fails the run: the sections are still written
    expect(harness.generations().map(generation => generation.response))
      .toContain(`## Induction\n${sectionBody('Induction')}`)
  })

  // The record gate's consequence: a critique that failed still recorded its
  // round, so a later resume does not ask for it again. Without the line the
  // failure path stores, there would be no generation, no round, and the stage
  // would fire on every resume of the script for as long as it existed.
  it('records the round of a critique that failed, so a resume does not re-ask for it', async () => {
    const harness = setup({
      sectionStream: title =>
        title === OUTLINE_CRITIQUE_SECTION_TITLE ? failsImmediately() : null
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    // Through the file, because that is where it would be lost: a generation
    // holding an empty response is dropped by the serializer's admission test,
    // and its round record goes with it.
    const reloaded = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown({
        ...harness.conversation,
        generations: harness.generations()
      })
    )!

    expect(reloaded.generations[1].round).toMatchObject({ kind: 'outline-critique' })

    const document = projectConversation(reloaded)
    expect(document.rounds.some(round => round.kind === 'outline-critique')).toBe(true)
    expect(planNextRound(document, resolvePipeline({ reviewPass: true }))).toBeNull()
  })

  it('keeps the failed critique turn, and its prompt, across a save and reload', async () => {
    const harness = setup({
      sectionStream: title =>
        title === OUTLINE_CRITIQUE_SECTION_TITLE ? failsImmediately() : null
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    const stored = { ...harness.conversation, generations: harness.generations() }
    const reloaded = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(stored)
    )

    expect(reloaded!.generations).toHaveLength(harness.generations().length)
    // The turn AFTER the failure keeps its own prompt rather than inheriting
    // the dropped one's
    const induction = reloaded!.generations.find(generation =>
      generation.response.startsWith('## Induction')
    )
    expect([...induction!.messages].reverse().find(message => message.role === 'user')!.content)
      .toContain('Now write the "Induction" section')
  })

  it('closes the generation when the style review fails', async () => {
    const harness = setup({
      sectionStream: title =>
        title === STYLE_REVIEW_SECTION_TITLE ? failsImmediately() : null
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations()[harness.generations().length - 1].response).toBe(
      'No style review was written: the request ended before the model finished.'
    )
  })

  it('closes the generation when a section request fails before any prose arrives', async () => {
    const harness = setup({
      sectionStream: title => (title === 'Deepener' ? failsImmediately() : null)
    })

    await expect(harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )).rejects.toThrow()

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations().map(generation => generation.response))
      .toContain('Nothing was written: the request ended before the model finished.')
  })

  it('leaves a half-written section exactly as it streamed in', async () => {
    // The rule is only about an EMPTY response: a run that failed part way
    // through a section keeps what arrived, heading and all, as it always has
    const harness = setup({
      sectionStream: title => (title === 'Deepener' ? failsPartWayThrough() : null)
    })

    await expect(harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )).rejects.toThrow()

    expect(harness.generations()[harness.generations().length - 1].response)
      .toBe('## Deepener\nBreathe out, and')
  })

  it('closes the generation when a section regeneration fails', async () => {
    const conversation: RawConversation = {
      id: 'conv-1',
      scriptId: 'script-1',
      generations: [
        makeGeneration(outlineText),
        makeGeneration(`## Induction\n${sectionBody('Induction')}`)
      ],
      createdAt: 0,
      updatedAt: 0
    }
    const harness = setup({ conversation, sectionStream: () => failsImmediately() })

    await expect(harness.orchestrator.regenerateSection(
      { prompt: 'Now rewrite the "Induction" section', conversationId: 'conv-1', sectionTitle: 'Induction' },
      conversation
    )).rejects.toThrow()

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations()[harness.generations().length - 1].response).toBe(
      'No section was written for "Induction": the request ended before the model finished.'
    )
  })

  it('closes the generation when a whole-script refinement fails', async () => {
    const conversation: RawConversation = {
      id: 'conv-1',
      scriptId: 'script-1',
      generations: [
        makeGeneration(outlineText),
        makeGeneration(`## Induction\n${sectionBody('Induction')}`)
      ],
      createdAt: 0,
      updatedAt: 0
    }
    const harness = setup({ conversation, sectionStream: () => failsImmediately() })

    await expect(harness.orchestrator.refineScript(
      { prompt: 'Make it warmer', conversationId: 'conv-1' },
      conversation
    )).rejects.toThrow()

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations()[harness.generations().length - 1].response).toBe(
      'No refinement was written: the request ended before the model finished.'
    )
  })

  // A turn that THREW is only half the problem. A stream can finish on the
  // provider's own terms while carrying nothing at all — no prose, no tool
  // call — and the turn then completes normally with an empty response, which
  // the serializer refuses to write: the request, its prompt and its cost
  // disappear from the file on the next save. Success has to be closed with an
  // admissible response for the same reason failure does.
  async function* finishesEmpty(): AsyncGenerator<ProviderFrame, void, unknown> {
    yield { kind: 'finished', reason: 'stop' }
  }

  // Whether a turn is open is answered from what this class dispatched, not
  // from `getConversation` — that callback reads a ref the provider reassigns
  // when React re-renders, and awaiting a stream is not a render, so it can
  // still be answering with the conversation as it was before the turn opened.
  it('closes the open turn even when the conversation reads back stale', async () => {
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
    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => failsImmediately(),
        regenerateSection: () => failsImmediately()
      },
      exampleService: { searchExamples: async () => [] }
    }
    const orchestrator = new RawScriptGenerationOrchestrator(services, {
      dispatch: action => { state = rawConversationReducer(state, action) },
      appDispatch: () => {},
      saveConversation: () => {},
      // Frozen at the moment the run started, the way a ref React has not
      // reassigned yet reads
      getConversation: () => conversation,
      getScript: () => ({ model: 'gpt-3.5-turbo-instruct' })
    })

    await expect(orchestrator.generateScript({ prompt: 'A deep rest script' }, conversation))
      .rejects.toThrow()

    const generations = state.conversations[0].generations
    expect(generations).toHaveLength(1)
    expect(generations[0].response)
      .toBe('Nothing was written: the request ended before the model finished.')
  })

  it('closes a turn whose stream succeeds while carrying nothing', async () => {
    const harness = setup({
      sectionStream: title => (title === STYLE_REVIEW_SECTION_TITLE ? finishesEmpty() : null)
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations()[harness.generations().length - 1].response)
      .toBe('The request finished without writing anything.')
  })

  it('keeps an empty-but-successful turn across a save and reload', async () => {
    const harness = setup({
      sectionStream: title => (title === STYLE_REVIEW_SECTION_TITLE ? finishesEmpty() : null)
    })

    await harness.orchestrator.generateScript(
      { prompt: 'A deep rest script' },
      harness.conversation
    )

    const stored = { ...harness.conversation, generations: harness.generations() }
    const reloaded = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(stored)
    )

    expect(reloaded!.generations).toHaveLength(harness.generations().length)
    expect(reloaded!.generations[reloaded!.generations.length - 1].response)
      .toBe('The request finished without writing anything.')
  })

  it('closes an empty-but-successful refinement turn', async () => {
    const conversation: RawConversation = {
      id: 'conv-1',
      scriptId: 'script-1',
      generations: [
        makeGeneration(outlineText),
        makeGeneration(`## Induction\n${sectionBody('Induction')}`)
      ],
      createdAt: 0,
      updatedAt: 0
    }
    const harness = setup({ conversation, sectionStream: () => finishesEmpty() })

    await harness.orchestrator.refineScript(
      { prompt: 'Make it warmer', conversationId: 'conv-1' },
      conversation
    )

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations()[harness.generations().length - 1].response)
      .toBe('The request finished without writing anything.')
  })

  it('closes the generation when an on-demand script review fails', async () => {
    const conversation: RawConversation = {
      id: 'conv-1',
      scriptId: 'script-1',
      generations: [
        makeGeneration(outlineText),
        makeGeneration(`## Induction\n${sectionBody('Induction')}`)
      ],
      createdAt: 0,
      updatedAt: 0
    }
    const harness = setup({ conversation, sectionStream: () => failsImmediately() })

    await expect(harness.orchestrator.reviewScript(conversation, 'A deep rest script'))
      .rejects.toThrow()

    expect(harness.generations().filter(generation => !generation.response)).toEqual([])
    expect(harness.generations()[harness.generations().length - 1].response).toBe(
      'No script review was written: the request ended before the model finished.'
    )
  })
})

// The choke point every one of this class's conversation dispatches goes
// through, exercised as itself. What it guarantees — no turn is ever closed
// with a record the serializer refuses, and no turn is closed twice — is
// stated in terms of one open turn at a time, and several of its cases are
// only reachable in a running app through a race: a restart or a discard
// landing while an earlier run's stream is still in flight. Driving the choke
// point directly is the only way to pin those without racing two runs.
describe('the dispatch choke point and the turn it holds open', () => {
  type Internals = {
    dispatch: (action: RawConversationAction) => void
    streamOrClose: (
      conversationId: string,
      subject: string,
      run: () => Promise<unknown>
    ) => Promise<unknown>
    closeOpenGeneration: (conversationId: string, subject: string) => void
  }

  const EMPTY_TURN_RECORD = 'The request finished without writing anything.'

  const setup = () => {
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

    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => textFrames(outlineText),
        regenerateSection: request => textFrames(`## ${request.sectionTitle}\nBreathe.`)
      },
      exampleService: { searchExamples: async () => [] }
    }

    const actions: RawConversationAction[] = []
    const orchestrator = new RawScriptGenerationOrchestrator(services, {
      dispatch: action => {
        actions.push(action)
        state = rawConversationReducer(state, action)
      },
      appDispatch: () => {},
      saveConversation: () => {},
      getConversation: id => state.conversations.find(entry => entry.id === id),
      getScript: () => ({ model: 'gpt-3.5-turbo-instruct' })
    })

    return {
      internals: orchestrator as unknown as Internals,
      conversation,
      actions,
      generations: () => state.conversations[0].generations,
      // What the next reload of the saved file would hold: the test of whether
      // a turn was closed with something the serializer will actually write
      reloaded: () => parseConversationFromYamlMarkdown(
        serializeConversationToYamlMarkdown({
          ...conversation,
          generations: state.conversations[0].generations
        })
      )
    }
  }

  const open = (internals: Internals) =>
    internals.dispatch({
      type: 'START_GENERATION',
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'write me a script about rest' }]
    })

  it('records a turn that completed with nothing but whitespace, which reloads no better than an empty one', () => {
    const harness = setup()
    open(harness.internals)

    harness.internals.dispatch({
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv-1',
      response: '  \n \t '
    })

    expect(harness.generations()[0].response).toBe(EMPTY_TURN_RECORD)
    // The reason the whitespace could not simply be left: the serializer
    // writes it as a blank block and the parser trims it away, taking the
    // whole generation — the request and its prompt — with it
    expect(harness.reloaded()!.generations).toHaveLength(1)
    expect(harness.reloaded()!.generations[0].response).toBe(EMPTY_TURN_RECORD)
  })

  it('leaves a turn that completed with tool calls and no prose exactly as it was written', () => {
    const harness = setup()
    open(harness.internals)

    harness.internals.dispatch({
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv-1',
      response: '',
      toolCalls: [{ id: 'call_1', name: 'grounding_select', status: 'accepted' }]
    })

    // Calls are enough for the serializer to admit the generation, so there is
    // nothing to substitute for and the record must not be rewritten
    expect(harness.generations()[0].response).toBe('')
    expect(harness.generations()[0].toolCalls).toEqual([
      { id: 'call_1', name: 'grounding_select', status: 'accepted' }
    ])
    expect(harness.reloaded()!.generations).toHaveLength(1)
    expect(harness.reloaded()!.generations[0].toolCalls).toEqual([
      { id: 'call_1', name: 'grounding_select', status: 'accepted' }
    ])
  })

  it('does not close a completed turn a second time when a later path tries to', () => {
    const harness = setup()
    open(harness.internals)

    harness.internals.dispatch({
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv-1',
      response: '## Induction\nBreathe out slowly.'
    })

    // A completion closes the turn, so a failure path running afterwards finds
    // nothing open. Were the turn still thought to be open — and still thought
    // to hold no prose, since only streaming deltas write a body — this would
    // overwrite a finished generation with a failure line.
    harness.internals.closeOpenGeneration('conv-1', 'Nothing was written')

    expect(harness.generations()).toHaveLength(1)
    expect(harness.generations()[0].response).toBe('## Induction\nBreathe out slowly.')
  })

  it('does not close a completed turn from a stream that throws afterwards', async () => {
    const harness = setup()
    open(harness.internals)

    harness.internals.dispatch({
      type: 'COMPLETE_GENERATION',
      conversationId: 'conv-1',
      response: '## Induction\nBreathe out slowly.'
    })

    await expect(harness.internals.streamOrClose('conv-1', 'No section was written', () => {
      throw new Error('the provider connection dropped')
    })).rejects.toThrow('the provider connection dropped')

    // The generation the closed turn wrote is still the generation it wrote
    expect(harness.generations()).toHaveLength(1)
    expect(harness.generations()[0].response).toBe('## Induction\nBreathe out slowly.')
  })

  for (const handover of ['GENERATION_RESTARTED', 'GENERATIONS_DISCARDED'] as const) {
    it(`forgets the turn a run left open once ${handover} hands the conversation to a new run`, async () => {
      const harness = setup()
      open(harness.internals)
      harness.internals.dispatch({
        type: 'UPDATE_CURRENT_GENERATION',
        conversationId: 'conv-1',
        response: '## Induction\nHalf a section arrived before'
      })

      // Both actions say a NEW run now owns this conversation, and both are
      // dispatched before that run opens a turn of its own. The previous run's
      // stream can still be in flight and still throw afterwards; when it
      // does, the turn it opened is no longer a turn to close, and closing it
      // would write a failure line over what the new run's conversation holds.
      harness.internals.dispatch({ type: handover, conversationId: 'conv-1' })

      await expect(harness.internals.streamOrClose('conv-1', 'Nothing was written', () => {
        throw new Error('the provider connection dropped')
      })).rejects.toThrow('the provider connection dropped')

      expect(harness.actions.filter(action => action.type === 'COMPLETE_GENERATION')).toEqual([])
    })
  }

  it('keeps a half-written draft that a restart handed to a new run', () => {
    const harness = setup()
    open(harness.internals)
    harness.internals.dispatch({
      type: 'UPDATE_CURRENT_GENERATION',
      conversationId: 'conv-1',
      response: '## Induction\nHalf a section arrived before'
    })

    harness.internals.dispatch({ type: 'GENERATION_RESTARTED', conversationId: 'conv-1' })
    harness.internals.closeOpenGeneration('conv-1', 'Nothing was written')

    // A restart keeps the generations, so the draft the interrupted run left
    // is still there to be resumed from — and a stale close must not replace
    // it with a failure line
    expect(harness.generations()[0].response).toBe('## Induction\nHalf a section arrived before')
  })
})

// MAJOR 7: this is the only thing deciding whether a stream still arriving is
// written to storage at all, so a reader who reloads mid-run keeps what has
// been written. Unguarded, a regression in either direction is silent: too
// eager costs a serialize-and-store on every text frame, too slow costs the
// reader everything since the last save.
describe('StreamPersistence: how often a stream in flight is saved', () => {
  it('saves the first frame of a run, whenever in the clock it arrives', () => {
    expect(new StreamPersistence().due(1_700_000_000_000)).toBe(true)
  })

  it('does not save again until the throttle has passed', () => {
    const saves = new StreamPersistence(1000)

    expect(saves.due(10_000)).toBe(true)
    expect(saves.due(10_500)).toBe(false)
    expect(saves.due(11_000)).toBe(false)
  })

  it('saves again once it has', () => {
    const saves = new StreamPersistence(1000)

    expect(saves.due(10_000)).toBe(true)
    expect(saves.due(10_900)).toBe(false)
    expect(saves.due(11_001)).toBe(true)
    // and the window restarts from the save that was actually made, not from
    // the frame that was turned away
    expect(saves.due(11_900)).toBe(false)
    expect(saves.due(12_002)).toBe(true)
  })

  // Per run, not per orchestrator: a run is the scope over which "since the
  // last save" means anything.
  it('starts each run with its own window', () => {
    const first = new StreamPersistence(1000)
    first.due(10_000)

    expect(new StreamPersistence(1000).due(10_500)).toBe(true)
  })
})

// MAJOR 6 + MAJOR 4, end to end. ensureSectionHeading leaves a reply that
// already starts with '##' alone, so a model that heads its answer with a
// title of its own stores the body under THAT title. The planner matches by
// title, never sees the one it planned, and asks again — for every round left
// in the budget if nothing bounds it, and then, if the ceiling reported
// success, dispatched a script with a hole in it as complete.
describe('a section the model will not write under the planned title', () => {
  const outline = [
    '# Deep Rest',
    '## Induction',
    'Settle the listener with slow breathing.',
    '## Awakening',
    'Count back up to full alertness.'
  ].join('\n')

  const body = (label: string) =>
    `${label} ` + Array.from({ length: SECTION_TARGET_WORDS - 1 }, (_, i) => `word${i}`).join(' ')

  const setup = () => {
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
    const scriptUpdates: Partial<Script>[] = []

    const services: RawScriptServices = {
      scriptService: {
        generateScript: () => textFrames(outline),
        // Every section comes back under a heading the model chose, so the
        // planned title is never written
        regenerateSection: () => textFrames(`## A Gentle Beginning\n${body('Beginning')}`)
      },
      exampleService: { searchExamples: async () => [] }
    }

    const callbacks: RawGenerationCallbacks = {
      dispatch: action => { state = rawConversationReducer(state, action) },
      appDispatch: action => { scriptUpdates.push(action.updates) },
      saveConversation: () => {},
      getConversation: id => state.conversations.find(entry => entry.id === id),
      // No tool calling, so the run writes as prose — the path where a reply
      // can carry a heading of its own at all
      getScript: () => ({ model: 'gpt-3.5-turbo-instruct' })
    }

    return {
      orchestrator: new RawScriptGenerationOrchestrator(services, callbacks, {}),
      conversation,
      getState: () => state,
      scriptUpdates
    }
  }

  it('gives up by name instead of asking for it until the round budget runs out', async () => {
    const { orchestrator, conversation, getState, scriptUpdates } = setup()

    await expect(orchestrator.generateScript(
      { prompt: 'A deep rest script', conversationId: conversation.id },
      conversation
    )).rejects.toThrow(/"Induction"/)

    // Twice, not sixty-four times
    const sectionRounds = getState().conversations[0].generations
      .filter(generation => generation.round?.kind === 'section')
    expect(sectionRounds).toHaveLength(2)

    // And the run failed rather than reporting a script with a hole in it
    expect(getState().generationMachine?.phase).toBe('error')
    expect(scriptUpdates.some(update => update.status === 'complete')).toBe(false)
    expect(scriptUpdates.some(update => update.status === 'draft')).toBe(true)
  })
})
