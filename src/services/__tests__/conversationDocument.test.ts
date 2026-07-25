import { describe, it, expect } from 'vitest'
import {
  parseMarkdownSections,
  consolidateSections,
  getLatestOutline,
  ensureSectionHeading,
  isOutlineResponse
} from '../conversationDocument'
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
  'Settle the listener.',
  '## Awakening',
  'Return to alertness.'
].join('\n')

describe('isOutlineResponse', () => {
  it('detects a document-level heading as an outline', () => {
    expect(isOutlineResponse(outlineText)).toBe(true)
  })

  it('does not treat a section response as an outline', () => {
    expect(isOutlineResponse('## Induction\nBody text.')).toBe(false)
  })
})

describe('parseMarkdownSections', () => {
  it('splits content into titled sections', () => {
    const sections = parseMarkdownSections('## One\nFirst body.\n\n## Two\nSecond body.')

    expect(sections).toEqual([
      { title: 'One', content: 'First body.' },
      { title: 'Two', content: 'Second body.' }
    ])
  })

  it('returns nothing for content without section headings', () => {
    expect(parseMarkdownSections('Just prose, no headings.')).toEqual([])
  })
})

describe('consolidateSections', () => {
  it('skips outline generations and replaces sections by title, later wins', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nOriginal body.',
      '## Awakening\nAwakening body.',
      '## Induction\nRewritten body.'
    ])

    expect(consolidateSections(conversation)).toEqual([
      { title: 'Induction', content: 'Rewritten body.' },
      { title: 'Awakening', content: 'Awakening body.' }
    ])
  })

  it('replaces multiple sections from a single refinement generation', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nOriginal induction.',
      '## Awakening\nOriginal awakening.',
      '## Induction\nRefined induction.\n\n## Awakening\nRefined awakening.'
    ])

    expect(consolidateSections(conversation)).toEqual([
      { title: 'Induction', content: 'Refined induction.' },
      { title: 'Awakening', content: 'Refined awakening.' }
    ])
  })
})

describe('getLatestOutline', () => {
  it('returns the most recent parseable outline', () => {
    const laterOutline = '# Second Plan\n## Arrival\nArrive gently.'
    const conversation = makeConversation([
      outlineText,
      '## Induction\nBody.',
      laterOutline
    ])

    expect(getLatestOutline(conversation)?.title).toBe('Second Plan')
  })

  it('returns null when no outline exists', () => {
    expect(getLatestOutline(makeConversation(['## Induction\nBody.']))).toBeNull()
  })
})

describe('ensureSectionHeading', () => {
  it('prepends the section heading when missing', () => {
    expect(ensureSectionHeading('Induction', 'Body text.')).toBe('## Induction\nBody text.')
  })

  it('leaves text alone when it already starts with a heading', () => {
    expect(ensureSectionHeading('Induction', '## Induction\nBody text.'))
      .toBe('## Induction\nBody text.')
  })
})
