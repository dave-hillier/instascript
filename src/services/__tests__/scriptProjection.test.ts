import { describe, it, expect } from 'vitest'
import {
  projectConversation,
  parseSections,
  sectionSlug,
  sectionStatusNote
} from '../scriptProjection'
import { consolidateSections } from '../conversationDocument'
import type { Generation, GenerationToolCall, RawConversation } from '../../types/conversation'

// The seam has two branches and one conversation can contain both, so the
// tests are written per generation kind and then interleaved.

const markdownGeneration = (response: string): Generation => ({
  messages: [],
  response,
  timestamp: 0
})

const toolGeneration = (
  response: string,
  toolCalls: Array<Omit<GenerationToolCall, 'id'>>
): Generation => ({
  messages: [],
  response,
  timestamp: 0,
  toolCalls: toolCalls.map((call, index) => ({ id: `call_${index}`, ...call }))
})

const conversationOf = (...generations: Generation[]): RawConversation => ({
  id: 'conversation_1',
  scriptId: 'script_1',
  generations,
  createdAt: 0,
  updatedAt: 0
})

describe('parseSections', () => {
  it('gives each section a slug id and a word count', () => {
    expect(parseSections('## Deepening Trance\nBreathe out, and let go.').sections).toEqual([
      {
        id: 'section_deepening_trance',
        title: 'Deepening Trance',
        content: 'Breathe out, and let go.',
        wordCount: 5
      }
    ])
  })

  it('takes the document title only from a "# " first line', () => {
    expect(parseSections('# The Garden\n\n## Arrival\nWords.').title).toBe('The Garden')
    expect(parseSections('\n# The Garden\n\n## Arrival\nWords.').title).toBeUndefined()
  })

  it('counts an empty section body as zero words', () => {
    const { sections } = parseSections('## Arrival\n')

    expect(sections[0].content).toBe('')
    expect(sections[0].wordCount).toBe(0)
  })
})

describe('sectionSlug', () => {
  it('reduces a title to the id the reading view wires into aria-controls', () => {
    expect(sectionSlug('Return & Emergence')).toBe('section_return___emergence')
  })
})

describe('projectConversation: markdown generations', () => {
  it('projects nothing for a conversation with no generations', () => {
    expect(projectConversation(undefined)).toEqual({ title: undefined, sections: [], fullContent: '' })
    expect(projectConversation(conversationOf())).toEqual({ title: undefined, sections: [], fullContent: '' })
  })

  it('takes only the title from outlines and lets the last outline win', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('# First Plan\n\n## Arrival\nA plan, not prose.'),
      markdownGeneration('## Arrival\nThe written words.'),
      markdownGeneration('# Second Plan\n\n## Arrival\nA revised plan.')
    ))

    expect(document.title).toBe('Second Plan')
    expect(document.sections).toEqual([
      { id: 'section_arrival', title: 'Arrival', content: 'The written words.', wordCount: 3 }
    ])
    expect(document.fullContent).toBe('# Second Plan\n\n## Arrival\nThe written words.')
  })

  it('replaces a section with the later generation of the same title', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('## Arrival\nFirst attempt.'),
      markdownGeneration('## Emergence\nThe ending.'),
      markdownGeneration('## Arrival\nSecond attempt.')
    ))

    expect(document.sections.map(s => [s.title, s.content])).toEqual([
      ['Arrival', 'Second attempt.'],
      ['Emergence', 'The ending.']
    ])
  })
})

describe('projectConversation: tool-call generations', () => {
  it('folds an accepted section_write, taking the body from the rendered response', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nThe written words.', [
        { name: 'section_write', title: 'Arrival', status: 'accepted', wordCount: 3 }
      ])
    ))

    expect(document.sections).toEqual([
      { id: 'section_arrival', title: 'Arrival', content: 'The written words.', wordCount: 3 }
    ])
  })

  it('takes the title from outline_write and ignores grounding_select', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('', [{ name: 'grounding_select', status: 'accepted' }]),
      toolGeneration('# The Garden\n\n## Arrival\nA plan.', [
        { name: 'outline_write', title: 'The Garden', status: 'accepted' }
      ])
    ))

    expect(document.title).toBe('The Garden')
    expect(document.sections).toEqual([])
  })

  it('skips a rejected attempt and folds the accepted rewrite that followed it', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nThe rewritten words.', [
        { name: 'section_write', title: 'Arrival', status: 'rejected', wordCount: 12 },
        { name: 'section_write', title: 'Arrival', status: 'accepted', wordCount: 3 }
      ])
    ))

    expect(document.sections).toEqual([
      { id: 'section_arrival', title: 'Arrival', content: 'The rewritten words.', wordCount: 3 }
    ])
  })

  it('folds a waived call like any other: it was accepted, short as it is', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nToo short.', [
        { name: 'section_write', title: 'Arrival', status: 'waived', wordCount: 2 }
      ])
    ))

    expect(document.sections[0].content).toBe('Too short.')
    expect(document.sections[0].wordCount).toBe(2)
  })

  it('carries a waiver onto the section so the reading view can show it', () => {
    // D5: the waiver has to stay visible. A section kept without passing the
    // length window must not project byte-identically to a clean one, or it is
    // indistinguishable everywhere a reader can look.
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nToo short.', [
        {
          name: 'section_write',
          title: 'Arrival',
          status: 'waived',
          wordCount: 2,
          reason: 'kept at 2 words after 4 attempts'
        }
      ])
    ))

    expect(document.sections[0].status).toBe('waived')
    expect(document.sections[0].statusReason).toBe('kept at 2 words after 4 attempts')
  })

  it('leaves a cleanly accepted section unmarked', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nThe written words.', [
        { name: 'section_write', title: 'Arrival', status: 'accepted', wordCount: 3 }
      ])
    ))

    expect(document.sections[0].status).toBeUndefined()
    expect(document.sections[0].statusReason).toBeUndefined()
  })

  it('folds every section of a tool-written response, not only the one named', () => {
    // The rendered response is the sole storage of prose, so a body that came
    // back as two headings must not lose its second one: it would vanish from
    // the reading view and the export while still sitting in the conversation.
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nThe first words.\n\n## Emergence\nThe ending.', [
        { name: 'section_write', title: 'Arrival', status: 'accepted', wordCount: 3 }
      ])
    ))

    expect(document.sections.map(section => [section.title, section.content])).toEqual([
      ['Arrival', 'The first words.'],
      ['Emergence', 'The ending.']
    ])
    expect(document.fullContent).toContain('The ending.')
  })

  it('does not resurrect the extra prose of a wholly rejected attempt', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('## Arrival\nRefused.\n\n## Emergence\nAlso refused.', [
        { name: 'section_write', title: 'Arrival', status: 'rejected', wordCount: 900 }
      ])
    ))

    expect(document.sections).toEqual([])
  })

  it('reads a headerless response as the whole body', () => {
    const document = projectConversation(conversationOf(
      toolGeneration('Breathe, and let go.\n', [
        { name: 'section_write', title: 'Arrival', status: 'accepted' }
      ])
    ))

    expect(document.sections[0]).toEqual({
      id: 'section_arrival',
      title: 'Arrival',
      content: 'Breathe, and let go.',
      wordCount: 4
    })
  })

  it('lets a section_revise replace an earlier markdown section of the same title', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('# The Garden\n\n## Arrival\nA plan.'),
      markdownGeneration('## Arrival\nThe first words.'),
      toolGeneration('## Arrival\nThe revised words.', [
        { name: 'section_revise', title: 'Arrival', status: 'accepted', wordCount: 3 }
      ])
    ))

    expect(document.title).toBe('The Garden')
    expect(document.sections).toEqual([
      { id: 'section_arrival', title: 'Arrival', content: 'The revised words.', wordCount: 3 }
    ])
  })
})

describe('projectConversation: the live splice', () => {
  const streaming = (sectionTitle: string) => ({
    conversationId: 'conversation_1',
    isComplete: false,
    sectionTitle
  })

  it('splices the in-flight rewrite over the stored section', () => {
    const document = projectConversation(
      conversationOf(
        markdownGeneration('## Arrival\nThe stored words.'),
        markdownGeneration('## Arrival\nThe words arriving now')
      ),
      streaming('Arrival')
    )

    expect(document.sections[0].content).toBe('The words arriving now')
    expect(document.sections[0].wordCount).toBe(4)
  })

  it('appends a streaming section only once its heading has arrived', () => {
    const stored = markdownGeneration('## Arrival\nThe stored words.')

    expect(projectConversation(
      conversationOf(stored, markdownGeneration('Headless words so far')),
      streaming('Emergence')
    ).sections.map(s => s.title)).toEqual(['Arrival'])

    expect(projectConversation(
      conversationOf(stored, markdownGeneration('## Emergence\n')),
      streaming('Emergence')
    ).sections.map(s => s.title)).toEqual(['Arrival', 'Emergence'])
  })

  it('withholds the splice from another conversation and from a finished generation', () => {
    // The splice reads the last generation whatever section it holds, so a
    // mismatched conversation or a completed generation is visible as Arrival
    // keeping its own stored words instead of Emergence's.
    const conversation = conversationOf(
      markdownGeneration('## Arrival\nThe stored words.'),
      markdownGeneration('## Emergence\nThe ending.')
    )

    expect(projectConversation(conversation, streaming('Arrival')).sections[0].content)
      .toBe('The ending.')
    expect(projectConversation(conversation, { conversationId: 'other', isComplete: false, sectionTitle: 'Arrival' })
      .sections[0].content).toBe('The stored words.')
    expect(projectConversation(conversation, { conversationId: 'conversation_1', isComplete: true, sectionTitle: 'Arrival' })
      .sections[0].content).toBe('The stored words.')
  })
})

describe('sectionStatusNote', () => {
  // D5's one demand is that a waiver stays visible. The reading view renders
  // whatever this returns, so these are the assertions standing behind the
  // note on the page.
  const section = (over: Partial<Parameters<typeof sectionStatusNote>[0]> = {}) => ({
    wordCount: 312,
    ...over
  })

  it('gives a waived section the handler\'s own justification', () => {
    expect(sectionStatusNote(section({
      status: 'waived',
      statusReason: 'kept at 312 words after 4 attempts'
    }))).toBe('Kept outside the length window: kept at 312 words after 4 attempts')
  })

  it('still speaks for a waived section that carries no reason', () => {
    expect(sectionStatusNote(section({ status: 'waived' })))
      .toBe('Kept outside the length window at 312 words')
  })

  it('says nothing about an accepted section or a section with no verdict', () => {
    expect(sectionStatusNote(section({ status: 'accepted' }))).toBeNull()
    expect(sectionStatusNote(section())).toBeNull()
  })
})

describe('the two folds agree about a rejected draft', () => {
  // A rejected attempt with no accepted rewrite after it. Ordering cannot
  // rescue this one: nothing upserts over it, so if either fold keeps it the
  // refused draft IS the section — in the reading view, in an export, and in
  // the text the review pass rewrites from.
  const refusedOnly = conversationOf(
    markdownGeneration('# The Garden\n\n## Arrival\nA plan.'),
    toolGeneration('## Arrival\nThe refused draft.', [
      { name: 'section_write', title: 'Arrival', status: 'rejected', wordCount: 900 }
    ])
  )

  it('projects no section at all for it', () => {
    const document = projectConversation(refusedOnly)

    expect(document.sections).toEqual([])
    expect(document.fullContent).not.toContain('The refused draft.')
  })

  it('consolidates no section at all for it', () => {
    expect(consolidateSections(refusedOnly)).toEqual([])
  })

  it('keeps a waived attempt in both folds, refused-looking word count and all', () => {
    const waived = conversationOf(
      toolGeneration('## Arrival\nToo short.', [
        { name: 'section_write', title: 'Arrival', status: 'waived', wordCount: 2, reason: 'kept at 2 words' }
      ])
    )

    expect(projectConversation(waived).sections[0].content).toBe('Too short.')
    expect(consolidateSections(waived)).toEqual([{ title: 'Arrival', content: 'Too short.' }])
  })
})
