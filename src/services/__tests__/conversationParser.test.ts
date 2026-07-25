import { describe, it, expect } from 'vitest'
import {
  serializeConversationToYamlMarkdown,
  parseConversationFromYamlMarkdown
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
