import { describe, it, expect } from 'vitest'
import {
  parseMarkdownSections,
  consolidateSections,
  getLatestOutline,
  ensureSectionHeading,
  isOutlineResponse
} from '../conversationDocument'
import { projectConversation } from '../scriptProjection'
import type { RawConversation, Generation, GenerationRound } from '../../types/conversation'

const makeGeneration = (response: string, round?: GenerationRound): Generation => ({
  messages: [],
  response,
  timestamp: 0,
  ...(round ? { round } : {})
})

const makeConversation = (responses: string[]): RawConversation => ({
  id: 'conv-1',
  scriptId: 'script-1',
  generations: responses.map(response => makeGeneration(response)),
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

  // The two folds have to agree about what the script says: this one feeds the
  // prompts, the reviewed script and the filesystem export, and the projection
  // feeds the reading view. A critique worded under '## ' headings is a reply
  // ABOUT the script, and belongs to neither.
  it('skips a critique round\'s reply, however it is worded', () => {
    const conversation: RawConversation = {
      ...makeConversation([]),
      generations: [
        makeGeneration(outlineText, { round: 1, kind: 'outline' }),
        makeGeneration('## Induction\nBreathe out slowly.', { round: 2, kind: 'section', sectionIndex: 0 }),
        makeGeneration(
          '## Induction\nVERDICT: violates 6 | Cliched imagery.',
          { round: 3, kind: 'style-critique' }
        )
      ]
    }

    expect(consolidateSections(conversation))
      .toEqual([{ title: 'Induction', content: 'Breathe out slowly.' }])
    // and the projection beside it says exactly the same thing
    expect(projectConversation(conversation, null, { lastGenerationSettled: true })
      .sections.map(section => ({ title: section.title, content: section.content })))
      .toEqual([{ title: 'Induction', content: 'Breathe out slowly.' }])
  })

  // The rewrites a critique round performs are stamped 'section', not
  // 'style-critique': they are section revisions, and both folds must keep
  // them or the reader and the export disagree about what the script says.
  it('keeps a section rewritten during a critique round', () => {
    const conversation: RawConversation = {
      ...makeConversation([]),
      generations: [
        makeGeneration(outlineText, { round: 1, kind: 'outline' }),
        makeGeneration('## Induction\nBreathe out slowly.', { round: 2, kind: 'section', sectionIndex: 0 }),
        makeGeneration('VERDICT: violates 6', { round: 3, kind: 'style-critique' }),
        makeGeneration('## Induction\nThe revised induction.', { round: 3, kind: 'section' })
      ]
    }

    expect(consolidateSections(conversation))
      .toEqual([{ title: 'Induction', content: 'The revised induction.' }])
    expect(projectConversation(conversation, null, { lastGenerationSettled: true })
      .sections[0].content).toBe('The revised induction.')
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
