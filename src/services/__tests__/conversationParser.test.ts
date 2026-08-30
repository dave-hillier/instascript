import { describe, it, expect } from 'vitest'
import {
  serializeConversationToYamlMarkdown,
  parseConversationFromYamlMarkdown,
  sanitizeGenerationToolCalls
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
