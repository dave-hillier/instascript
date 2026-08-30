import { describe, it, expect } from 'vitest'
import {
  serializeConversationToYamlMarkdown,
  parseConversationFromYamlMarkdown,
  sanitizeGenerationToolCalls,
  sanitizeGenerationMetrics,
  sanitizeGenerationRound
} from '../conversationParser'
import type { RawConversation } from '../../types/conversation'

describe('conversation YAML round-trip', () => {
  const conversation: RawConversation = {
    id: 'conv_1',
    scriptId: 'script_1',
    createdAt: 1000,
    updatedAt: 2000,
    generations: [
      {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'write me a script' }
        ],
        response: '# Outline\n## Induction\nPlan the induction.',
        timestamp: 1500,
        exampleIds: ['deep-sleep.md', 'example_123_abc']
      },
      {
        messages: [
          { role: 'user', content: 'write the induction section' }
        ],
        response: '## Induction\nBreathe out slowly.',
        timestamp: 1600
      }
    ]
  }

  it('preserves the example ids that informed a generation', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(conversation)
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.generations).toHaveLength(2)
    expect(parsed!.generations[0].exampleIds).toEqual(['deep-sleep.md', 'example_123_abc'])
    expect(parsed!.generations[1].exampleIds).toBeUndefined()
  })

  it('preserves responses alongside the example ids', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(conversation)
    )

    expect(parsed!.generations[0].response).toContain('Plan the induction.')
    expect(parsed!.generations[1].response).toContain('Breathe out slowly.')
  })
})

describe('conversation YAML tool calls', () => {
  const toolCallConversation = (): RawConversation => ({
    id: 'conv_tools',
    scriptId: 'script_tools',
    createdAt: 1000,
    updatedAt: 3000,
    generations: [
      {
        messages: [{ role: 'user', content: 'write the induction section' }],
        response: '## Induction\nBreathe out slowly.',
        timestamp: 1700,
        toolCalls: [
          { id: 'call_1', name: 'section_write', title: 'Induction', status: 'rejected', wordCount: 212, reason: 'under 400 words' },
          { id: 'call_2', name: 'section_write', title: 'Induction', status: 'accepted', wordCount: 512 }
        ]
      }
    ]
  })

  it('round-trips tool calls through serialize and parse', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(toolCallConversation())
    )

    expect(parsed!.generations[0].toolCalls).toEqual(toolCallConversation().generations[0].toolCalls)
  })

  it('is stable across serialize -> parse -> serialize, with and without tool calls', () => {
    const withoutCalls: RawConversation = {
      ...toolCallConversation(),
      generations: [{
        ...toolCallConversation().generations[0],
        toolCalls: undefined
      }]
    }

    for (const conversation of [withoutCalls, toolCallConversation()]) {
      const once = serializeConversationToYamlMarkdown(conversation)
      const twice = serializeConversationToYamlMarkdown(
        parseConversationFromYamlMarkdown(once)!
      )
      expect(twice).toBe(once)
    }
  })

  it('keeps a generation that made tool calls but produced no prose', () => {
    // Without a response block the generation's prompt would be held over and
    // attached to whatever generation came next, losing the calls entirely
    const bodiless: RawConversation = {
      ...toolCallConversation(),
      generations: [
        {
          messages: [{ role: 'user', content: 'ground yourself in the corpus' }],
          response: '',
          timestamp: 1800,
          toolCalls: [{ id: 'call_g', name: 'grounding_select', status: 'accepted' }]
        },
        {
          messages: [{ role: 'user', content: 'write the outline' }],
          response: '# Outline',
          timestamp: 1900
        }
      ]
    }

    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(bodiless)
    )

    expect(parsed!.generations).toHaveLength(2)
    expect(parsed!.generations[0].response).toBe('')
    expect(parsed!.generations[0].toolCalls).toEqual([
      { id: 'call_g', name: 'grounding_select', status: 'accepted' }
    ])
    // The parser accumulates the running message history, so what matters is
    // that the second prompt landed on the second generation rather than
    // being swallowed by a bodiless first one
    expect(parsed!.generations[0].messages.map(m => m.content)).toEqual([
      'ground yourself in the corpus'
    ])
    expect(parsed!.generations[1].messages.map(m => m.content)).toEqual([
      'ground yourself in the corpus',
      'write the outline',
      '# Outline'
    ])
  })

  it('parses a file written before the field existed, leaving tool calls absent', () => {
    const oldFile = [
      '---',
      'type: conversation',
      'id: conv_old',
      'scriptId: script_old',
      'createdAt: 1',
      'updatedAt: 2',
      '---',
      '',
      '---',
      'type: prompt',
      'timestamp: 3',
      'role: user',
      '---',
      'write me a script',
      '',
      '---',
      'type: response',
      'timestamp: 3',
      'role: assistant',
      '---',
      '## Induction',
      ''
    ].join('\n')

    const parsed = parseConversationFromYamlMarkdown(oldFile)

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].response).toBe('## Induction')
    expect(parsed!.generations[0].toolCalls).toBeUndefined()
  })

  it('a file written with tool calls still reads correctly where the field is ignored', () => {
    // Stands in for an older deployed build: strip the toolCalls key from the
    // serialized file and the prose, prompts and pairing must be unaffected
    const serialized = serializeConversationToYamlMarkdown(toolCallConversation())
    const withoutField = serialized.replace(/^toolCalls:\n(?: {2}.*\n)*/gm, '')

    const parsed = parseConversationFromYamlMarkdown(withoutField)

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].response).toBe('## Induction\nBreathe out slowly.')
    expect(parsed!.generations[0].messages[0].content).toBe('write the induction section')
    expect(parsed!.generations[0].toolCalls).toBeUndefined()
  })

  it('drops tool calls it cannot make sense of rather than failing the parse', () => {
    expect(sanitizeGenerationToolCalls([
      { id: 'ok', name: 'section_write', status: 'accepted', wordCount: 500 },
      { id: 'no_such_tool', name: 'section_invent', status: 'accepted' },
      { id: '', name: 'section_write', status: 'accepted' },
      { id: 'bad_status', name: 'section_write', status: 'maybe' },
      'not an object',
      null
    ])).toEqual([{ id: 'ok', name: 'section_write', status: 'accepted', wordCount: 500 }])

    expect(sanitizeGenerationToolCalls('nonsense')).toBeUndefined()
    expect(sanitizeGenerationToolCalls([{ id: 'x', name: 'nope', status: 'accepted' }])).toBeUndefined()
    expect(sanitizeGenerationToolCalls(undefined)).toBeUndefined()
  })
})

describe('conversation YAML prompts', () => {
  // The shape every generation after the outline actually has in memory: the
  // whole flattened conversation (buildConversationHistory) with this
  // generation's own request appended last.
  const flattened: RawConversation = {
    id: 'conv_flat',
    scriptId: 'script_flat',
    createdAt: 1000,
    updatedAt: 2000,
    generations: [
      {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'write me a script about rest' }
        ],
        response: '# Rest\n## Induction\nPlan the induction.',
        timestamp: 1500
      },
      {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'write me a script about rest' },
          { role: 'assistant', content: '# Rest\n## Induction\nPlan the induction.' },
          { role: 'user', content: 'Now write the "Induction" section' }
        ],
        response: '## Induction\nBreathe out slowly.',
        timestamp: 1600
      },
      {
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'write me a script about rest' },
          { role: 'assistant', content: '# Rest\n## Induction\nPlan the induction.' },
          { role: 'user', content: 'Now write the "Induction" section' },
          { role: 'assistant', content: '## Induction\nBreathe out slowly.' },
          { role: 'user', content: 'Now rewrite the "Induction" section' }
        ],
        response: '## Induction\nBreathe out more slowly.',
        timestamp: 1700
      }
    ]
  }

  it('stores the request each generation actually made, not the outline prompt', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(flattened)
    )

    const lastUserOf = (index: number) =>
      [...parsed!.generations[index].messages].reverse()
        .find(message => message.role === 'user')!.content

    expect(lastUserOf(0)).toBe('write me a script about rest')
    expect(lastUserOf(1)).toBe('Now write the "Induction" section')
    expect(lastUserOf(2)).toBe('Now rewrite the "Induction" section')
  })

  it('round-trips a multi-generation conversation without drifting', () => {
    const once = serializeConversationToYamlMarkdown(flattened)
    const twice = serializeConversationToYamlMarkdown(
      parseConversationFromYamlMarkdown(once)!
    )

    expect(twice).toBe(once)
  })

  it('rebuilds the accumulating history a follow-up request replays', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(flattened)
    )

    expect(parsed!.generations[2].messages.map(message => message.content)).toEqual([
      'write me a script about rest',
      '# Rest\n## Induction\nPlan the induction.',
      'Now write the "Induction" section',
      '## Induction\nBreathe out slowly.',
      'Now rewrite the "Induction" section',
      '## Induction\nBreathe out more slowly.'
    ])
  })

  // The prompt slot has a counterpart: which ASSISTANT message stands in when
  // a generation carries no response of its own. A generation's `messages` end
  // with its own assistant turn — that is how parsing rebuilds them — so the
  // LAST one is this generation's answer and the earlier ones belong to the
  // generations before it.
  it('falls back to this generation’s assistant turn, not the first in the history', () => {
    const toolOnly: RawConversation = {
      id: 'conv_tool_only',
      scriptId: 'script_tool_only',
      createdAt: 1000,
      updatedAt: 2000,
      generations: [
        {
          messages: [
            { role: 'user', content: 'write me a script about rest' },
            { role: 'assistant', content: '# Rest\n## Induction\nPlan the induction.' },
            { role: 'user', content: 'Now write the "Induction" section' },
            { role: 'assistant', content: '## Induction\nBreathe out slowly.' }
          ],
          response: '',
          timestamp: 1600,
          toolCalls: [
            { id: 'call_1', name: 'section_write', title: 'Induction', status: 'accepted', wordCount: 4 }
          ]
        }
      ]
    }

    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(toolOnly)
    )

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].response).toBe('## Induction\nBreathe out slowly.')
  })

  it('keeps an epoch-zero createdAt instead of re-stamping it with now', () => {
    const atEpoch: RawConversation = {
      id: 'conv_epoch',
      scriptId: 'script_epoch',
      createdAt: 0,
      updatedAt: 0,
      generations: [
        {
          messages: [{ role: 'user', content: 'write me a script about rest' }],
          response: '# Rest',
          timestamp: 0
        }
      ]
    }

    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(atEpoch)
    )

    expect(parsed!.createdAt).toBe(0)
    expect(parsed!.updatedAt).toBe(0)
  })

  it('still parses an old file whose prompt slot holds the outline prompt', () => {
    // Written by the build that serialized the FIRST user message: both
    // generations were filed under the outline prompt. It must load without
    // error, keeping the wrong prompt it already has rather than failing.
    const oldFile = [
      '---',
      'type: conversation',
      'id: conv_old',
      'scriptId: script_old',
      'createdAt: 1',
      'updatedAt: 2',
      '---',
      '',
      '---',
      'type: prompt',
      'timestamp: 3',
      'role: user',
      '---',
      'write me a script about rest',
      '',
      '---',
      'type: response',
      'timestamp: 3',
      'role: assistant',
      '---',
      '# Rest',
      '',
      '---',
      'type: prompt',
      'timestamp: 4',
      'role: user',
      '---',
      'write me a script about rest',
      '',
      '---',
      'type: response',
      'timestamp: 4',
      'role: assistant',
      '---',
      '## Induction',
      ''
    ].join('\n')

    const parsed = parseConversationFromYamlMarkdown(oldFile)

    expect(parsed!.generations).toHaveLength(2)
    expect(parsed!.generations[1].response).toBe('## Induction')
    expect([...parsed!.generations[1].messages].reverse()
      .find(message => message.role === 'user')!.content)
      .toBe('write me a script about rest')
  })
})


describe('per-generation run metrics', () => {
  const withMetrics: RawConversation = {
    id: 'conv_m',
    scriptId: 'script_m',
    createdAt: 1000,
    updatedAt: 2000,
    generations: [
      {
        messages: [{ role: 'user', content: 'write me a script about rest' }],
        response: '# Rest\n## Induction\nPlan the induction.',
        timestamp: 1500,
        metrics: {
          startedAt: 1400,
          endedAt: 1500,
          firstTokenAt: 1420,
          promptTokens: 900,
          completionTokens: 120,
          cachedTokens: 768,
          finishReason: 'stop'
        }
      }
    ]
  }

  it('carries what a request cost through a save and a reload', () => {
    const reparsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(withMetrics)
    )

    expect(reparsed!.generations[0].metrics).toEqual({
      startedAt: 1400,
      endedAt: 1500,
      firstTokenAt: 1420,
      promptTokens: 900,
      completionTokens: 120,
      cachedTokens: 768,
      finishReason: 'stop'
    })
  })

  it('is byte-stable across a second save, so opening a file does not rewrite it', () => {
    const once = serializeConversationToYamlMarkdown(withMetrics)
    const twice = serializeConversationToYamlMarkdown(
      parseConversationFromYamlMarkdown(once)!
    )

    expect(twice).toBe(once)
  })

  it('reads a file written before metrics existed as having none', () => {
    const oldFile = [
      '---',
      'type: conversation',
      'id: conv_old',
      'scriptId: script_old',
      'createdAt: 1',
      'updatedAt: 2',
      '---',
      '',
      '---',
      'type: prompt',
      'timestamp: 3',
      'role: user',
      '---',
      'write me a script about rest',
      '',
      '---',
      'type: response',
      'timestamp: 3',
      'role: assistant',
      '---',
      '# Rest',
      ''
    ].join('\n')

    const parsed = parseConversationFromYamlMarkdown(oldFile)

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].response).toBe('# Rest')
    expect(parsed!.generations[0].metrics).toBeUndefined()
  })

  it('never lets metrics alone keep a generation with nothing written in it', () => {
    // The admission test is prose or a tool call. A turn that measured a
    // request but wrote nothing must still be dropped, because the deployed
    // parser drops it — writing it would strand its prompt on the generation
    // that follows.
    const serialized = serializeConversationToYamlMarkdown({
      id: 'conv_empty',
      scriptId: 'script_empty',
      createdAt: 1,
      updatedAt: 2,
      generations: [
        {
          messages: [{ role: 'user', content: 'the request that measured nothing' }],
          response: '',
          timestamp: 3,
          metrics: { startedAt: 1, endedAt: 2, promptTokens: 40 }
        },
        {
          messages: [{ role: 'user', content: 'the request that wrote something' }],
          response: '## Induction\nBreathe.',
          timestamp: 4
        }
      ]
    })

    expect(serialized).not.toContain('metrics')

    const reparsed = parseConversationFromYamlMarkdown(serialized)
    expect(reparsed!.generations).toHaveLength(1)
    expect(reparsed!.generations[0].metrics).toBeUndefined()
    // The dropped turn's prompt block is still written, and the reparse hangs
    // it on nothing — which is exactly why a metrics-only generation must not
    // be written in the first place
    expect(reparsed!.generations[0].messages.at(-2)?.content)
      .toBe('the request that wrote something')
  })
})

// The serializer writes metrics through the same sanitizer that reads them
// back, so what the file holds is only ever what a reload can reconstruct.
// Without that, a generation carrying a half-built or junk-laden metrics
// record — anything the in-memory object picked up that the parser will not
// admit — is written verbatim, and the first reload silently rewrites the file.
describe('metrics are sanitized on the way out, not only on the way in', () => {
  const withUnreadableMetrics = (metrics: unknown): RawConversation => ({
    id: 'conv_s',
    scriptId: 'script_s',
    createdAt: 1000,
    updatedAt: 2000,
    generations: [
      {
        messages: [{ role: 'user', content: 'write me a script about rest' }],
        response: '# Rest\n## Induction\nPlan the induction.',
        timestamp: 1500,
        metrics: metrics as never
      }
    ]
  })

  it('writes nothing for a record with no span, which the parser would not admit', () => {
    const once = serializeConversationToYamlMarkdown(
      withUnreadableMetrics({ promptTokens: 900, completionTokens: 120 })
    )

    expect(once).not.toContain('promptTokens')
    expect(parseConversationFromYamlMarkdown(once)!.generations[0].metrics).toBeUndefined()
    expect(serializeConversationToYamlMarkdown(parseConversationFromYamlMarkdown(once)!)).toBe(once)
  })

  it('writes only the fields a reload keeps, so the second save matches the first', () => {
    const once = serializeConversationToYamlMarkdown(
      withUnreadableMetrics({
        startedAt: 1400,
        endedAt: 1500,
        promptTokens: 'nine hundred',
        completionTokens: Number.NaN,
        cachedTokens: 768,
        finishReason: '',
        aborted: false,
        modelSaidSo: 'not a metrics field'
      })
    )

    expect(once).not.toContain('modelSaidSo')
    expect(once).not.toContain('nine hundred')
    expect(parseConversationFromYamlMarkdown(once)!.generations[0].metrics)
      .toEqual({ startedAt: 1400, endedAt: 1500, cachedTokens: 768 })
    expect(serializeConversationToYamlMarkdown(parseConversationFromYamlMarkdown(once)!)).toBe(once)
  })
})

describe('sanitizeGenerationMetrics', () => {
  it('requires the span, because nothing else on the record is required', () => {
    expect(sanitizeGenerationMetrics({ promptTokens: 10 })).toBeUndefined()
    expect(sanitizeGenerationMetrics({ startedAt: 1 })).toBeUndefined()
    expect(sanitizeGenerationMetrics(undefined)).toBeUndefined()
    expect(sanitizeGenerationMetrics('1400')).toBeUndefined()
    expect(sanitizeGenerationMetrics([{ startedAt: 1, endedAt: 2 }])).toBeUndefined()
    expect(sanitizeGenerationMetrics({ startedAt: 1, endedAt: 2 }))
      .toEqual({ startedAt: 1, endedAt: 2 })
  })

  it('drops a malformed field on its own rather than the whole record', () => {
    expect(sanitizeGenerationMetrics({
      startedAt: 1,
      endedAt: 2,
      promptTokens: 'nine hundred',
      completionTokens: Number.NaN,
      cachedTokens: 768,
      finishReason: '',
      aborted: 'yes'
    })).toEqual({ startedAt: 1, endedAt: 2, cachedTokens: 768 })
  })

  it('treats only an explicit true as an abort', () => {
    expect(sanitizeGenerationMetrics({ startedAt: 1, endedAt: 2, aborted: false })!.aborted)
      .toBeUndefined()
    expect(sanitizeGenerationMetrics({ startedAt: 1, endedAt: 2, aborted: true })!.aborted)
      .toBe(true)
  })
})

describe('round records survive the file', () => {
  const withRound = (round: unknown): RawConversation => ({
    id: 'conv_r',
    scriptId: 'script_r',
    createdAt: 1000,
    updatedAt: 2000,
    generations: [{
      messages: [{ role: 'user', content: 'critique this outline' }],
      response: 'VERDICT: APPROVED',
      timestamp: 1500,
      round: round as never
    }]
  })

  it('round-trips the round a generation was produced for', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(withRound({ round: 3, kind: 'section', sectionIndex: 1 }))
    )
    expect(parsed!.generations[0].round).toEqual({ round: 3, kind: 'section', sectionIndex: 1 })
  })

  it('keeps the generation when the round names a stage this build cannot plan', () => {
    const once = serializeConversationToYamlMarkdown(withRound({ round: 3, kind: 'regrounding' }))
    const parsed = parseConversationFromYamlMarkdown(once)

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].response).toBe('VERDICT: APPROVED')
    expect(parsed!.generations[0].round).toBeUndefined()
  })

  it('writes only what a reload keeps, so the second save matches the first', () => {
    const once = serializeConversationToYamlMarkdown(withRound({
      round: 3,
      kind: 'section',
      sectionIndex: Number.NaN,
      plannedBy: 'a build that knew more'
    }))

    expect(once).not.toContain('plannedBy')
    expect(once).not.toContain('sectionIndex')
    expect(parseConversationFromYamlMarkdown(once)!.generations[0].round)
      .toEqual({ round: 3, kind: 'section' })
    expect(serializeConversationToYamlMarkdown(parseConversationFromYamlMarkdown(once)!)).toBe(once)
  })

  // The admission test the round record must never join: the already-deployed
  // parser has never heard of `round`, so a generation earning its place
  // through one alone would be dropped THERE and strand its prompt onto the
  // next generation. Every round handler stores a non-empty line instead.
  it('drops a generation whose only content is a round record', () => {
    const conversation: RawConversation = {
      id: 'conv_r',
      scriptId: 'script_r',
      createdAt: 1000,
      updatedAt: 2000,
      generations: [{
        messages: [{ role: 'user', content: 'critique this outline' }],
        response: '',
        timestamp: 1500,
        round: { round: 2, kind: 'outline-critique' }
      }]
    }
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(conversation)
    )
    expect(parsed!.generations).toHaveLength(0)
  })
})

describe('sanitizeGenerationRound', () => {
  it('requires a finite round number and a kind it recognises', () => {
    expect(sanitizeGenerationRound({ kind: 'section' })).toBeUndefined()
    expect(sanitizeGenerationRound({ round: Number.NaN, kind: 'section' })).toBeUndefined()
    expect(sanitizeGenerationRound({ round: '3', kind: 'section' })).toBeUndefined()
    expect(sanitizeGenerationRound({ round: 3, kind: 'briefing' })).toBeUndefined()
    expect(sanitizeGenerationRound(undefined)).toBeUndefined()
    expect(sanitizeGenerationRound([{ round: 3, kind: 'section' }])).toBeUndefined()
    expect(sanitizeGenerationRound({ round: 3, kind: 'section' }))
      .toEqual({ round: 3, kind: 'section' })
  })

  it('accepts every kind this build can plan', () => {
    for (const kind of ['outline', 'outline-critique', 'section', 'style-critique', 'review']) {
      expect(sanitizeGenerationRound({ round: 1, kind })).toEqual({ round: 1, kind })
    }
  })
})

describe('the critique a judging generation recorded', () => {
  const critiqueConversation = (critique: unknown): RawConversation => ({
    id: 'conv_critique',
    scriptId: 'script_critique',
    createdAt: 1000,
    updatedAt: 3000,
    generations: [
      {
        messages: [{ role: 'user', content: 'review this script' }],
        response: 'The style pass marked 1 section.',
        timestamp: 1700,
        critique: critique as RawConversation['generations'][number]['critique']
      }
    ]
  })

  const fullCritique = {
    stage: 'style' as const,
    verdict: 'revise' as const,
    findings: [{
      section: 'Deepening',
      rules: [6],
      spans: [{ quote: 'drift down and down', before: 'Let yourself ', after: '.', occurrence: 1 }],
      revisions: 2,
      reason: 'Ocean imagery.'
    }]
  }

  it('round-trips a critique through serialize and parse', () => {
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(critiqueConversation(fullCritique))
    )

    expect(parsed!.generations[0].critique).toEqual(fullCritique)
  })

  it('round-trips an approving critique, which is what makes an approval durable', () => {
    const approval = { stage: 'style' as const, verdict: 'pass' as const, findings: [] }
    const parsed = parseConversationFromYamlMarkdown(
      serializeConversationToYamlMarkdown(critiqueConversation(approval))
    )

    expect(parsed!.generations[0].critique).toEqual(approval)
  })

  it('is stable across serialize -> parse -> serialize, with and without a critique', () => {
    for (const critique of [undefined, fullCritique]) {
      const once = serializeConversationToYamlMarkdown(critiqueConversation(critique))
      const twice = serializeConversationToYamlMarkdown(parseConversationFromYamlMarkdown(once)!)
      expect(twice).toBe(once)
    }
  })

  // These read RAW YAML rather than round-tripping, because the serializer
  // sanitizes on the way out too: a file written by a newer build, or hand
  // edited, is what the read side actually has to survive.
  const yamlWithCritique = (critique: string): string => [
    '---',
    'type: conversation',
    'id: conv_critique',
    'scriptId: script_critique',
    'createdAt: 1000',
    'updatedAt: 3000',
    '---',
    '---',
    'type: prompt',
    'timestamp: 1700',
    'role: user',
    '---',
    'review this script',
    '',
    '---',
    'type: response',
    'timestamp: 1700',
    'role: assistant',
    critique,
    '---',
    'The style pass marked 1 section.',
    ''
  ].join('\n')

  it('drops a record that names no stage this build knows, keeping the generation', () => {
    const parsed = parseConversationFromYamlMarkdown(yamlWithCritique(
      'critique:\n  stage: reading\n  verdict: pass\n  findings: []'
    ))

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].response).toBe('The style pass marked 1 section.')
    expect(parsed!.generations[0].critique).toBeUndefined()
  })

  it('drops a malformed finding and keeps the rest of the critique', () => {
    const parsed = parseConversationFromYamlMarkdown(yamlWithCritique([
      'critique:',
      '  stage: style',
      '  verdict: revise',
      '  findings:',
      '    - section: ""',
      '      reason: no section',
      '    - section: Deepening',
      '      reason: Ocean imagery.',
      '    - section: Awakening'
    ].join('\n')))

    expect(parsed!.generations[0].critique!.findings).toEqual([
      { section: 'Deepening', reason: 'Ocean imagery.' }
    ])
  })

  it('drops a span with no quote, since the context alone finds nothing', () => {
    const parsed = parseConversationFromYamlMarkdown(yamlWithCritique([
      'critique:',
      '  stage: style',
      '  verdict: revise',
      '  findings:',
      '    - section: Deepening',
      '      spans:',
      '        - before: "Let yourself "',
      '          after: "."',
      '          occurrence: 0',
      '      revisions: 2',
      '      reason: Ocean imagery.'
    ].join('\n')))

    const finding = parsed!.generations[0].critique!.findings[0]
    expect(finding.spans).toBeUndefined()
    // revisions goes with the spans it was recorded for: on its own it is a
    // number about nothing
    expect(finding.revisions).toBeUndefined()
  })

  it('reads a conversation written by a build that never heard of a critique', () => {
    const serialized = serializeConversationToYamlMarkdown(critiqueConversation(fullCritique))
    const withoutField = serialized.replace(/^critique:\n(?: {2}.*\n)*/gm, '')

    const parsed = parseConversationFromYamlMarkdown(withoutField)

    expect(parsed!.generations).toHaveLength(1)
    expect(parsed!.generations[0].critique).toBeUndefined()
    expect(parsed!.generations[0].response).toBe('The style pass marked 1 section.')
  })
})
