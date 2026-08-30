import { describe, it, expect } from 'vitest'
import { getScriptDocument, type CurrentGeneration } from '../scriptPageDocument'
import type { RawConversation } from '../../types/conversation'

// Characterisation tests: they pin down what the reading view's projection does
// today, quirks included, so the move to tool-call authoring can be seen to
// change behaviour deliberately rather than by accident.

const conversationOf = (...responses: string[]): RawConversation => ({
  id: 'conversation_1',
  scriptId: 'script_1',
  generations: responses.map(response => ({
    messages: [],
    response,
    timestamp: 0
  })),
  createdAt: 0,
  updatedAt: 0
})

const streaming = (sectionTitle?: string): CurrentGeneration => ({
  conversationId: 'conversation_1',
  isComplete: false,
  sectionTitle
})

describe('getScriptDocument', () => {
  it('has nothing to show for a conversation with no generations', () => {
    const document = getScriptDocument(conversationOf(), null)

    expect(document).toEqual({
      sections: [],
      fullContent: '',
      isGenerating: false,
      hasError: false,
      errorMessage: undefined
    })
  })

  it('skips outline generations, taking only their title, and lets the last outline win', () => {
    const document = getScriptDocument(
      conversationOf(
        '# First Plan\n\n## Arrival\nA description of the section, not script prose.',
        '## Arrival\nThe written words.',
        '# Second Plan\n\n## Arrival\nA revised description.'
      ),
      null
    )

    expect(document.title).toBe('Second Plan')
    // The outline's own "## Arrival" body never reaches the reading view
    expect(document.sections).toEqual([
      {
        id: 'section_arrival',
        title: 'Arrival',
        content: 'The written words.',
        wordCount: 3
      }
    ])
  })

  it('consolidates repeated sections by title, last generation wins', () => {
    const document = getScriptDocument(
      conversationOf(
        '## Arrival\nFirst attempt.',
        '## Emergence\nThe ending.',
        '## Arrival\nSecond attempt, rewritten.'
      ),
      null
    )

    expect(document.sections.map(section => [section.title, section.content])).toEqual([
      ['Arrival', 'Second attempt, rewritten.'],
      ['Emergence', 'The ending.']
    ])
  })

  it('splices the in-flight rewrite of an existing section over the stored one', () => {
    const document = getScriptDocument(
      conversationOf(
        '## Arrival\nThe stored words.',
        '## Arrival\nThe words arriving now'
      ),
      streaming('Arrival')
    )

    expect(document.sections).toEqual([
      {
        id: 'section_arrival',
        title: 'Arrival',
        content: 'The words arriving now',
        wordCount: 4
      }
    ])
    expect(document.isGenerating).toBe(true)
  })

  it('appends a streaming section that is not consolidated yet', () => {
    const document = getScriptDocument(
      conversationOf(
        '## Arrival\nThe stored words.',
        '## Emergence\nThe words arriving now.'
      ),
      streaming('Emergence')
    )

    expect(document.sections.map(section => section.title)).toEqual(['Arrival', 'Emergence'])
    expect(document.sections[1].content).toBe('The words arriving now.')
  })

  it('shows a streaming section only once its "## Title" line has arrived', () => {
    const beforeHeading = getScriptDocument(
      conversationOf('## Arrival\nThe stored words.', 'The words arriving before any heading'),
      streaming('Emergence')
    )
    expect(beforeHeading.sections.map(section => section.title)).toEqual(['Arrival'])

    const afterHeading = getScriptDocument(
      conversationOf('## Arrival\nThe stored words.', '## Emergence\n'),
      streaming('Emergence')
    )
    expect(afterHeading.sections.map(section => section.title)).toEqual(['Arrival', 'Emergence'])
    expect(afterHeading.sections[1].wordCount).toBe(0)
  })

  it('leaves a rewrite in place until its heading arrives, rather than blanking it', () => {
    const document = getScriptDocument(
      conversationOf('## Arrival\nThe stored words.', 'The rewrite, still headless'),
      streaming('Arrival')
    )

    expect(document.sections[0].content).toBe('The stored words.')
  })

  it('ignores a generation belonging to another conversation', () => {
    const document = getScriptDocument(
      conversationOf('## Arrival\nThe stored words.', '## Emergence\nSomeone else is writing.'),
      { conversationId: 'conversation_2', isComplete: false, sectionTitle: 'Emergence' }
    )

    // The other conversation's section is still consolidated as a plain
    // generation; only the live splice and the generating flag are withheld
    expect(document.sections.map(section => section.title)).toEqual(['Arrival', 'Emergence'])
    expect(document.isGenerating).toBe(false)
  })

  it('rebuilds fullContent from the title and consolidated sections', () => {
    const document = getScriptDocument(
      conversationOf('# The Garden\n\n## Arrival\nA plan.', '## Arrival\nThe written words.'),
      null
    )

    expect(document.fullContent).toBe('# The Garden\n\n## Arrival\nThe written words.')
  })

  it('reports the current generation error whatever conversation it belongs to', () => {
    const document = getScriptDocument(conversationOf('## Arrival\nWords.'), {
      conversationId: 'conversation_2',
      isComplete: true,
      error: 'Rate limited'
    })

    expect(document.hasError).toBe(true)
    expect(document.errorMessage).toBe('Rate limited')
  })
})
