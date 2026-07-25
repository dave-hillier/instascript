import { describe, it, expect } from 'vitest'
import { duplicateRawConversation } from '../conversationStorage'
import type { RawConversation } from '../../types/conversation'

const sourceConversation = (): RawConversation => ({
  id: 'conv_1700000000000_source',
  scriptId: 'script_1700000000000_src',
  generations: [
    {
      messages: [
        { role: 'system', content: 'You write scripts.' },
        { role: 'user', content: 'A calm descent.' }
      ],
      response: '# Calm Descent\n\n## Settling\nBreathe...',
      timestamp: 1700000000001,
      exampleIds: ['ex-1']
    },
    {
      messages: [{ role: 'user', content: 'Regenerate the Settling section.' }],
      response: '## Settling\nSoften...',
      timestamp: 1700000000002
    }
  ],
  createdAt: 1700000000000,
  updatedAt: 1700000000002
})

describe('duplicateRawConversation', () => {
  it('creates a new conversation bound to the new script id', () => {
    const source = sourceConversation()
    const copy = duplicateRawConversation(source, 'script_1800000000000_new')

    expect(copy.scriptId).toBe('script_1800000000000_new')
    expect(copy.id).not.toBe(source.id)
  })

  it('carries over every generation with identical content', () => {
    const source = sourceConversation()
    const copy = duplicateRawConversation(source, 'script_1800000000000_new')

    expect(copy.generations).toHaveLength(2)
    expect(copy.generations).toEqual(source.generations)
  })

  it('deep-copies generations so the copy is independent of the source', () => {
    const source = sourceConversation()
    const copy = duplicateRawConversation(source, 'script_1800000000000_new')

    copy.generations[0].response = 'mutated'
    copy.generations[0].messages[0].content = 'mutated'

    expect(source.generations[0].response).toBe('# Calm Descent\n\n## Settling\nBreathe...')
    expect(source.generations[0].messages[0].content).toBe('You write scripts.')
  })

  it('returns an empty conversation when the source is missing', () => {
    const copy = duplicateRawConversation(undefined, 'script_1800000000000_new')

    expect(copy.scriptId).toBe('script_1800000000000_new')
    expect(copy.generations).toEqual([])
  })
})
