import { describe, it, expect } from 'vitest'
import {
  projectConversation,
  parseSections,
  sectionSlug,
  sectionStatusNote
} from '../scriptProjection'
import { consolidateSections } from '../conversationDocument'
import { parseOutlineCritiqueResponse } from '../outlineCritique'
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
    const empty = { title: undefined, outline: undefined, sections: [], rounds: [], fullContent: '' }
    expect(projectConversation(undefined)).toEqual(empty)
    expect(projectConversation(conversationOf())).toEqual(empty)
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

// A design review asked whether a critique or review generation's prose is
// folded as script content: neither fold skips one, because a critique
// response is neither an outline nor a rejected generation. It is not, and
// these pin why — the three critique prompts each ask for a shape that folds
// to nothing. VERDICT lines open no section, because a section is only opened
// by a "## " heading; and the outline critique's revision is stored as the
// revised outline itself, which both folds already skip as an outline.
describe('the critique and review passes fold as nothing', () => {
  const script = conversationOf(
    markdownGeneration('# Deep Rest\n\n## Induction\nA plan.'),
    markdownGeneration('## Induction\nBreathe out slowly and let go.')
  )

  const withCritique = (response: string): RawConversation =>
    conversationOf(...script.generations, markdownGeneration(response))

  const untouched = [{ title: 'Induction', content: 'Breathe out slowly and let go.' }]

  it('leaves the script untouched after a style critique', () => {
    // style-critique.txt: "Output only VERDICT lines, one per section"
    const conversation = withCritique(
      'VERDICT: Induction | compliant\nVERDICT: Awakening | violates 6 | Cliched imagery.'
    )

    expect(consolidateSections(conversation)).toEqual(untouched)
    expect(projectConversation(conversation).sections[0].content)
      .toBe('Breathe out slowly and let go.')
  })

  it('leaves the script untouched after a whole-script review, preamble and all', () => {
    const conversation = withCritique(
      'Here is my review of the script as a whole:\nVERDICT: Induction | cohesive'
    )

    expect(consolidateSections(conversation)).toEqual(untouched)
    expect(projectConversation(conversation).sections).toHaveLength(1)
  })

  it('leaves the script untouched when the outline critique approves', () => {
    const conversation = withCritique('OUTLINE OK')

    expect(consolidateSections(conversation)).toEqual(untouched)
    expect(projectConversation(conversation).sections).toHaveLength(1)
    expect(projectConversation(conversation).sections[0].content)
      .toBe('Breathe out slowly and let go.')
  })

  it('leaves the script untouched when the outline critique revises', () => {
    // The orchestrator stores the revision as exactly the revised outline
    // text, which begins at its "# " line, so both folds read it as an outline
    const revised = parseOutlineCritiqueResponse(
      'The balance is off.\n\n# Deep Rest\n## Induction\nSettle deeper.\n## Awakening\nReturn.'
    )
    const conversation = withCritique(revised.revisedOutlineText!)

    expect(consolidateSections(conversation)).toEqual(untouched)
    expect(projectConversation(conversation).title).toBe('Deep Rest')
  })
})

// --- what the round planner reads out of a conversation -------------------

const roundGeneration = (
  response: string,
  round: Generation['round'],
  toolCalls?: Array<Omit<GenerationToolCall, 'id'>>
): Generation => ({
  ...(toolCalls ? toolGeneration(response, toolCalls) : markdownGeneration(response)),
  round
})

describe('projectConversation: the plan the run is working to', () => {
  const plan = '# Deep Rest\n## Induction\nSettle.\n## Awakening\nReturn.'

  it('does not trust a prose outline that is the conversation\'s last generation', () => {
    // It may have been cut off mid-plan and still parse; a shortened plan
    // silently shortens the whole script.
    const document = projectConversation(conversationOf(markdownGeneration(plan)))

    expect(document.title).toBe('Deep Rest')
    expect(document.outline).toBeUndefined()
  })

  it('trusts a prose outline once the conversation has moved past it', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration(plan),
      markdownGeneration('## Induction\nBreathe out slowly.')
    ))

    expect(document.outline?.sections.map(section => section.title))
      .toEqual(['Induction', 'Awakening'])
  })

  it('trusts a tool-written outline that is the last generation, because the call finished', () => {
    const document = projectConversation(conversationOf(
      roundGeneration(plan, { round: 1, kind: 'outline' }, [
        { name: 'outline_write', title: 'Deep Rest', status: 'accepted' }
      ])
    ))

    expect(document.outline?.sections.map(section => section.title))
      .toEqual(['Induction', 'Awakening'])
  })

  it('takes no plan from a refused outline call', () => {
    const document = projectConversation(conversationOf(
      roundGeneration(plan, { round: 1, kind: 'outline' }, [
        { name: 'outline_write', status: 'rejected', reason: 'REJECTED: no usable plan' }
      ])
    ))

    expect(document.outline).toBeUndefined()
  })

  it('lets a revised plan from the outline critique supersede the first one', () => {
    const revised = '# Deep Rest\n## Induction\nSettle.\n## Deepening\nDown.\n## Awakening\nReturn.'
    const document = projectConversation(conversationOf(
      markdownGeneration(plan),
      roundGeneration(revised, { round: 2, kind: 'outline-critique' }),
      markdownGeneration('## Induction\nBreathe out slowly.')
    ))

    expect(document.outline?.sections.map(section => section.title))
      .toEqual(['Induction', 'Deepening', 'Awakening'])
  })
})

describe('projectConversation: the rounds a conversation has a record of', () => {
  it('collects them in the order they were admitted', () => {
    const document = projectConversation(conversationOf(
      roundGeneration('# Deep Rest\n## Induction\nSettle.', { round: 1, kind: 'outline' }),
      roundGeneration('VERDICT: OUTLINE OK', { round: 2, kind: 'outline-critique' }),
      roundGeneration('## Induction\nBreathe out.', { round: 3, kind: 'section', sectionIndex: 0 })
    ))

    expect(document.rounds).toEqual([
      { round: 1, kind: 'outline' },
      { round: 2, kind: 'outline-critique' },
      { round: 3, kind: 'section', sectionIndex: 0 }
    ])
  })

  // The asymmetry with the section fold, stated as a test: a round that
  // produced nothing still ran and still used its number.
  it('keeps the round of a wholly rejected generation, which the section fold drops', () => {
    const conversation = conversationOf(
      roundGeneration('## Induction\nToo short.', { round: 3, kind: 'section', sectionIndex: 0 }, [
        { name: 'section_write', title: 'Induction', status: 'rejected', wordCount: 12 }
      ])
    )
    const document = projectConversation(conversation)

    expect(document.sections).toEqual([])
    expect(document.rounds).toEqual([{ round: 3, kind: 'section', sectionIndex: 0 }])
  })

  it('tolerates a generation with no round at all, such as a manual edit', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('## Induction\nEdited by hand.'),
      roundGeneration('## Awakening\nReturn now.', { round: 4, kind: 'section', sectionIndex: 1 })
    ))

    expect(document.rounds).toEqual([{ round: 4, kind: 'section', sectionIndex: 1 }])
    expect(document.sections.map(section => section.title)).toEqual(['Induction', 'Awakening'])
  })
})

describe('projectConversation: which body a resume redoes', () => {
  it('suspects the prose body of the conversation\'s last generation', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('# Deep Rest\n## Induction\nSettle.'),
      markdownGeneration('## Induction\nBreathe out slowly.'),
      markdownGeneration('## Awakening\nAnd the stream stopped here')
    ))

    expect(document.sections.map(section => [section.title, section.truncationSuspect]))
      .toEqual([['Induction', undefined], ['Awakening', true]])
  })

  it('never suspects a tool-written body, because the call is the finish evidence', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('# Deep Rest\n## Induction\nSettle.'),
      roundGeneration('## Induction\nBreathe out slowly.', { round: 2, kind: 'section', sectionIndex: 0 }, [
        { name: 'section_write', title: 'Induction', status: 'accepted', wordCount: 3 }
      ])
    ))

    expect(document.sections[0].truncationSuspect).toBeUndefined()
  })

  it('clears the suspicion when a later generation rewrites the same section', () => {
    const document = projectConversation(conversationOf(
      markdownGeneration('## Induction\nCut off here'),
      markdownGeneration('## Awakening\nReturn now.')
    ))

    expect(document.sections.find(section => section.title === 'Induction')!.truncationSuspect)
      .toBeUndefined()
  })
})

describe('a critique round is a reply about the script, never part of it', () => {
  const script = conversationOf(
    markdownGeneration('# Deep Rest\n\n## Induction\nA plan.'),
    markdownGeneration('## Induction\nBreathe out slowly and let go.')
  )

  // The latent bug the round record fixes: a critique wording its verdicts
  // under "## " headings used to become sections of the script.
  it('does not turn a style critique\'s headings into sections', () => {
    const conversation = conversationOf(
      ...script.generations,
      roundGeneration(
        '## Induction\nVERDICT: violates 6 | Cliched imagery.\n\n## Awakening\nVERDICT: compliant',
        { round: 5, kind: 'style-critique' }
      )
    )
    const document = projectConversation(conversation)

    expect(document.sections.map(section => section.title)).toEqual(['Induction'])
    expect(document.sections[0].content).toBe('Breathe out slowly and let go.')
  })

  it('does not turn a whole-script review\'s headings into sections', () => {
    const conversation = conversationOf(
      ...script.generations,
      roundGeneration('## Continuity\nThe arc holds.', { round: 6, kind: 'review' })
    )

    expect(projectConversation(conversation).sections.map(section => section.title))
      .toEqual(['Induction'])
  })

  it('does not turn an outline critique\'s revised plan into sections', () => {
    const conversation = conversationOf(
      ...script.generations,
      roundGeneration('# Deep Rest\n## Induction\nSettle.\n## Awakening\nReturn.',
        { round: 3, kind: 'outline-critique' }),
      markdownGeneration('## Awakening\nAnd back into the room.')
    )
    const document = projectConversation(conversation)

    expect(document.sections.map(section => section.title)).toEqual(['Induction', 'Awakening'])
    expect(document.sections[0].content).toBe('Breathe out slowly and let go.')
  })
})

describe('a run folding its own conversation between rounds', () => {
  const plan = '# Deep Rest\n## Induction\nSettle.\n## Awakening\nReturn.'

  // Without this the loop could never move past its own outline round: the
  // plan it just wrote is the last generation, so the positional rule would
  // distrust it and the planner would ask for the outline again, forever.
  it('trusts the prose outline it has just closed itself', () => {
    const conversation = conversationOf(markdownGeneration(plan))

    expect(projectConversation(conversation).outline).toBeUndefined()
    expect(projectConversation(conversation, null, { lastGenerationSettled: true })
      .outline?.sections.map(section => section.title)).toEqual(['Induction', 'Awakening'])
  })

  it('does not suspect the prose section it has just closed itself', () => {
    const conversation = conversationOf(
      markdownGeneration(plan),
      markdownGeneration('## Induction\nBreathe out slowly.')
    )

    expect(projectConversation(conversation).sections[0].truncationSuspect).toBe(true)
    expect(projectConversation(conversation, null, { lastGenerationSettled: true })
      .sections[0].truncationSuspect).toBeUndefined()
  })

  it('carries the plan as it is stored, not as a re-render of the parse', () => {
    const wordy = '# Deep Rest\n## Induction\nSettle down.\nAnd further down.'

    expect(projectConversation(conversationOf(markdownGeneration(wordy)), null,
      { lastGenerationSettled: true }).outlineText).toBe(wordy)
  })

  it('has no plan text when it has no plan', () => {
    expect(projectConversation(conversationOf()).outlineText).toBeUndefined()
  })
})
