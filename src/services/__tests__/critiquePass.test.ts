import { describe, it, expect } from 'vitest'
import {
  parseCritiqueResponse,
  selectViolationsToRevise,
  buildRevisionInstruction,
  formatReviewSummary,
  reviewReportDescribesStructure,
  MAX_REVIEW_REVISIONS
} from '../critiquePass'
import { buildStyleCritiquePrompt, getStyleRules } from '../prompts'

describe('parseCritiqueResponse', () => {
  it('parses a compliant verdict', () => {
    const verdicts = parseCritiqueResponse('VERDICT: Induction | compliant')

    expect(verdicts).toEqual([
      { sectionTitle: 'Induction', compliant: true, ruleNumbers: [], reason: '' }
    ])
  })

  it('parses a violation with rule numbers and a reason', () => {
    const verdicts = parseCritiqueResponse(
      'VERDICT: Deepening | violates 6, 9 | Uses an ocean visualisation and negations.'
    )

    expect(verdicts).toEqual([
      {
        sectionTitle: 'Deepening',
        compliant: false,
        ruleNumbers: [6, 9],
        reason: 'Uses an ocean visualisation and negations.'
      }
    ])
  })

  it('parses one verdict per line across a full response', () => {
    const verdicts = parseCritiqueResponse([
      'VERDICT: Induction | compliant',
      'VERDICT: Deepening | violates 6 | Ocean imagery.',
      'VERDICT: Awakening | compliant'
    ].join('\n'))

    expect(verdicts.map(v => v.sectionTitle)).toEqual(['Induction', 'Deepening', 'Awakening'])
    expect(verdicts.map(v => v.compliant)).toEqual([true, false, true])
  })

  it('skips preamble, commentary and malformed lines', () => {
    const verdicts = parseCritiqueResponse([
      'Here is my review of the script:',
      'VERDICT: Induction | compliant',
      'VERDICT: broken line without a status',
      'VERDICT: Deepening | maybe fine?',
      'Overall a strong script.',
      'VERDICT: Awakening | violates 9 | Negations.'
    ].join('\n'))

    expect(verdicts.map(v => v.sectionTitle)).toEqual(['Induction', 'Awakening'])
  })

  it('tolerates case, bullets, whitespace and quoted titles', () => {
    const verdicts = parseCritiqueResponse([
      '  - verdict: "Induction" | Compliant',
      '* VERDICT: Deepening | Violates rules 3 and 9 | Pacing and negations.'
    ].join('\n'))

    expect(verdicts).toEqual([
      { sectionTitle: 'Induction', compliant: true, ruleNumbers: [], reason: '' },
      {
        sectionTitle: 'Deepening',
        compliant: false,
        ruleNumbers: [3, 9],
        reason: 'Pacing and negations.'
      }
    ])
  })

  it('keeps a violation without rule numbers, with an empty rule list', () => {
    const verdicts = parseCritiqueResponse('VERDICT: Deepening | violates | Too clinical.')

    expect(verdicts).toEqual([
      { sectionTitle: 'Deepening', compliant: false, ruleNumbers: [], reason: 'Too clinical.' }
    ])
  })

  it('joins a reason that itself contains pipes', () => {
    const verdicts = parseCritiqueResponse(
      'VERDICT: Deepening | violates 6 | Uses lakes | oceans | forests.'
    )

    expect(verdicts[0].reason).toBe('Uses lakes | oceans | forests.')
  })

  it('deduplicates rule numbers and keeps the first verdict per section', () => {
    const verdicts = parseCritiqueResponse([
      'VERDICT: Deepening | violates 6, 6, 9 | First verdict.',
      'VERDICT: Deepening | compliant'
    ].join('\n'))

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].ruleNumbers).toEqual([6, 9])
    expect(verdicts[0].reason).toBe('First verdict.')
  })

  it('returns an empty list for fully malformed output', () => {
    expect(parseCritiqueResponse('I cannot review this script.')).toEqual([])
    expect(parseCritiqueResponse('')).toEqual([])
  })
})

describe('selectViolationsToRevise', () => {
  const verdict = (sectionTitle: string, compliant: boolean) => ({
    sectionTitle,
    compliant,
    ruleNumbers: compliant ? [] : [6],
    reason: compliant ? '' : 'Reason.'
  })

  it('keeps only violations for sections that exist in the script', () => {
    const selected = selectViolationsToRevise(
      [verdict('Induction', true), verdict('Deepening', false), verdict('Imagined', false)],
      ['Induction', 'Deepening']
    )

    expect(selected.map(v => v.sectionTitle)).toEqual(['Deepening'])
  })

  it(`caps the selection at ${MAX_REVIEW_REVISIONS} sections per run`, () => {
    const titles = ['A', 'B', 'C', 'D']
    const selected = selectViolationsToRevise(
      titles.map(title => verdict(title, false)),
      titles
    )

    expect(selected).toHaveLength(MAX_REVIEW_REVISIONS)
    expect(selected.map(v => v.sectionTitle)).toEqual(['A', 'B'])
  })
})

describe('buildRevisionInstruction', () => {
  it('names the violated rules and includes the reason', () => {
    const instruction = buildRevisionInstruction({
      sectionTitle: 'Deepening',
      compliant: false,
      ruleNumbers: [6, 9],
      reason: 'Ocean imagery and negations.'
    })

    expect(instruction).toContain('style rules 6, 9')
    expect(instruction).toContain('Ocean imagery and negations.')
    expect(instruction).toContain('Rewrite the section')
  })

  it('falls back to a generic phrase when no rule numbers were parsed', () => {
    const instruction = buildRevisionInstruction({
      sectionTitle: 'Deepening',
      compliant: false,
      ruleNumbers: [],
      reason: ''
    })

    expect(instruction).toContain('the style rules')
    expect(instruction).not.toContain('rule undefined')
  })
})

describe('formatReviewSummary', () => {
  it('reports a pass when nothing was revised', () => {
    expect(formatReviewSummary([])).toBe(
      'Style review passed: every section follows the style rules.'
    )
  })

  it('lists revised sections with their rule numbers', () => {
    const summary = formatReviewSummary([
      { sectionTitle: 'Deepening', ruleNumbers: [6] },
      { sectionTitle: 'Awakening', ruleNumbers: [3, 9] }
    ])

    expect(summary).toBe(
      'Review revised 2 sections: Deepening (rule 6), Awakening (rules 3, 9).'
    )
  })

  it('uses the singular for one revised section', () => {
    expect(formatReviewSummary([{ sectionTitle: 'Deepening', ruleNumbers: [6] }])).toBe(
      'Review revised 1 section: Deepening (rule 6).'
    )
  })
})

describe('reviewReportDescribesStructure', () => {
  const structure = ['Induction', 'Deepening', 'Emergence']

  it('holds while the script still has the sections it reviewed', () => {
    expect(reviewReportDescribesStructure({ structure }, [...structure])).toBe(true)
  })

  it('retires once a section is added', () => {
    expect(reviewReportDescribesStructure(
      { structure },
      ['Induction', 'Deepening', 'Drift', 'Emergence']
    )).toBe(false)
  })

  it('retires once a section is removed', () => {
    expect(reviewReportDescribesStructure({ structure }, ['Induction', 'Emergence'])).toBe(false)
  })

  it('retires once a section is renamed', () => {
    expect(reviewReportDescribesStructure(
      { structure },
      ['Induction', 'Deep Drift', 'Emergence']
    )).toBe(false)
  })

  it('retires once the sections are reordered', () => {
    expect(reviewReportDescribesStructure(
      { structure },
      ['Induction', 'Emergence', 'Deepening']
    )).toBe(false)
  })

  it('holds for a report that recorded no structure to compare against', () => {
    expect(reviewReportDescribesStructure({}, ['Induction'])).toBe(true)
  })
})

describe('buildStyleCritiquePrompt', () => {
  it('embeds the style rules from the system prompt, keeping one source of truth', () => {
    const prompt = buildStyleCritiquePrompt('# Script\n\n## Induction\nBreathe.')

    expect(prompt).toContain(getStyleRules())
    expect(getStyleRules()).toContain('## Style rules')
    expect(getStyleRules()).toContain('Use marks to help with pacing')
  })

  it('embeds the script and the strict line format', () => {
    const prompt = buildStyleCritiquePrompt('# Script\n\n## Induction\nBreathe.')

    expect(prompt).toContain('## Induction\nBreathe.')
    expect(prompt).toContain('VERDICT: <section title> | compliant')
    expect(prompt).toContain('VERDICT: <section title> | violates')
  })
})
