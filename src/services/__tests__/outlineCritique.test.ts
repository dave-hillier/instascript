import { describe, it, expect } from 'vitest'
import { parseOutlineCritiqueResponse } from '../outlineCritique'
import { buildOutlineCritiquePrompt } from '../prompts'

const revisedOutline = [
  '# Deep Rest',
  '## Induction',
  'Settle the listener with slow breathing.',
  '## Deepener',
  'Descend a staircase while intensity gathers.',
  '## Awakening',
  'Count back up to full alertness.'
].join('\n')

describe('parseOutlineCritiqueResponse', () => {
  it('keeps the original outline when the critique approves it', () => {
    const result = parseOutlineCritiqueResponse('OUTLINE OK')

    expect(result.approved).toBe(true)
    expect(result.revisedOutline).toBeNull()
    expect(result.revisedOutlineText).toBeNull()
  })

  it('tolerates whitespace and casing around the approval', () => {
    const result = parseOutlineCritiqueResponse('\n  outline ok\n')
    expect(result.approved).toBe(true)
  })

  it('returns the revised outline when the critique rewrites it', () => {
    const result = parseOutlineCritiqueResponse(revisedOutline)

    expect(result.approved).toBe(false)
    expect(result.revisedOutlineText).toBe(revisedOutline)
    expect(result.revisedOutline?.title).toBe('Deep Rest')
    expect(result.revisedOutline?.sections.map(s => s.title)).toEqual([
      'Induction',
      'Deepener',
      'Awakening'
    ])
    expect(result.revisedOutline?.sections[1].description).toBe(
      'Descend a staircase while intensity gathers.'
    )
  })

  it('tolerates preamble before the revised outline', () => {
    const result = parseOutlineCritiqueResponse(
      'The escalation arc stalls in the middle. Here is a revised outline:\n\n' + revisedOutline
    )

    expect(result.approved).toBe(false)
    expect(result.revisedOutlineText).toBe(revisedOutline)
  })

  it('keeps the original outline when the response contains no parseable outline', () => {
    const result = parseOutlineCritiqueResponse('The outline is mostly fine but could be punchier.')

    expect(result.approved).toBe(true)
    expect(result.revisedOutline).toBeNull()
  })

  it('keeps the original outline when the response has a title but no sections', () => {
    const result = parseOutlineCritiqueResponse('# Deep Rest\n\nNo sections follow.')

    expect(result.approved).toBe(true)
  })
})

describe('buildOutlineCritiquePrompt', () => {
  it('includes the brief, the outline and the review criteria', () => {
    const prompt = buildOutlineCritiquePrompt('A script about restful sleep', revisedOutline)

    expect(prompt).toContain('A script about restful sleep')
    expect(prompt).toContain(revisedOutline)
    expect(prompt).toContain('Coverage')
    expect(prompt).toContain('Escalation arc')
    expect(prompt).toContain('Section balance')
    expect(prompt).toContain('OUTLINE OK')
  })

  it('is not corrupted by replacement patterns in the brief or outline', () => {
    const prompt = buildOutlineCritiquePrompt("Use $' and $& literally", '# T\n## S\nAlso $`.')

    expect(prompt).toContain("Use $' and $& literally")
    expect(prompt).toContain('Also $`.')
  })
})
