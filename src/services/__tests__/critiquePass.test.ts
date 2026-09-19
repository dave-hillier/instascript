import { describe, it, expect } from 'vitest'
import {
  acceptCritique,
  findingsFromVerdicts,
  formatReviewSummary,
  parseCritiqueResponse,
  parseCritiqueToolCall,
  renderCritique,
  reviewRevisionsFromFindings,
  reviewReportDescribesStructure,
  MAX_CRITIQUE_FINDINGS,
  MAX_SPANS_PER_FINDING
} from '../critiquePass'
import type { CritiqueSectionBody } from '../critiquePass'
import { buildStyleCritiquePrompt, getStyleRules, styleRuleNumbers } from '../prompts'
import { reanchorSpan, SPAN_MIN_CHARS } from '../span'

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

describe('formatReviewSummary', () => {
  it('reports a pass when nothing was revised', () => {
    expect(formatReviewSummary([])).toBe(
      'Style review passed: every section follows the style rules.'
    )
  })

  it('lists the sections it MARKED with their rule numbers, and never claims a rewrite', () => {
    const summary = formatReviewSummary([
      { sectionTitle: 'Deepening', ruleNumbers: [6] },
      { sectionTitle: 'Awakening', ruleNumbers: [3, 9] }
    ])

    expect(summary).toBe(
      'Style review marked 2 sections: Deepening (rule 6), Awakening (rules 3, 9).'
    )
  })

  it('uses the singular for one marked section', () => {
    expect(formatReviewSummary([{ sectionTitle: 'Deepening', ruleNumbers: [6] }])).toBe(
      'Style review marked 1 section: Deepening (rule 6).'
    )
  })

  it('never says the pass revised anything, because it no longer does', () => {
    const summary = formatReviewSummary([{ sectionTitle: 'Deepening', ruleNumbers: [6] }])
    expect(summary).not.toMatch(/revis/i)
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

  it('embeds the script and keeps the line format as the reply for a model with no tools', () => {
    const prompt = buildStyleCritiquePrompt('# Script\n\n## Induction\nBreathe.')

    expect(prompt).toContain('## Induction\nBreathe.')
    expect(prompt).toContain('VERDICT: <section title> | compliant')
    expect(prompt).toContain('VERDICT: <section title> | violates')
  })

  it('asks for the critique as a critique_record call, and forbids rewriting', () => {
    const prompt = buildStyleCritiquePrompt('# Script\n\n## Induction\nBreathe.')

    expect(prompt).toContain('critique_record')
    expect(prompt).toContain('CHARACTER FOR CHARACTER')
    expect(prompt).toMatch(/do not write, revise or improve/i)
  })
})

// A body long enough that a span can be quoted out of it and still clear
// SPAN_MIN_CHARS, with one phrase that deliberately occurs twice.
const DEEPENING_BODY = [
  'Sink a little further with every breath out, and let the sound of my voice carry you down.',
  'Sink a little further, deeper than before, and notice how easy it is to follow.',
  'Your body grows heavy and slow while the counting continues beneath my words.'
].join('\n')

const bodiesOf = (
  entries: Record<string, { body: string; revisions?: number }>
): Map<string, CritiqueSectionBody> =>
  new Map(
    Object.entries(entries).map(([title, value]) => [
      title,
      { body: value.body, revisions: value.revisions ?? 0 }
    ])
  )

const KNOWN_RULE = styleRuleNumbers()[0]
const INVENTED_RULE = Math.max(...styleRuleNumbers()) + 13

describe('parseCritiqueToolCall', () => {
  it('reads a whole critique out of the call arguments', () => {
    const args = parseCritiqueToolCall(JSON.stringify({
      stage: 'style',
      verdict: 'revise',
      findings: [{ section: 'Deepening', rules: [6], spans: ['a phrase'], reason: 'Ocean imagery.' }]
    }))

    expect(args).toEqual({
      stage: 'style',
      verdict: 'revise',
      findings: [{ section: 'Deepening', rules: [6], spans: ['a phrase'], reason: 'Ocean imagery.' }]
    })
  })

  it('is null for arguments that are not a critique at all', () => {
    expect(parseCritiqueToolCall('{ not json')).toBeNull()
    expect(parseCritiqueToolCall(JSON.stringify({ verdict: 'pass', findings: [] }))).toBeNull()
    expect(parseCritiqueToolCall(JSON.stringify({ stage: 'reading', verdict: 'pass', findings: [] })))
      .toBeNull()
    expect(parseCritiqueToolCall(JSON.stringify({ stage: 'style', verdict: 'maybe', findings: [] })))
      .toBeNull()
  })

  it('keeps a findings entry whose fields are the wrong shape, so acceptCritique can name what is wrong', () => {
    const args = parseCritiqueToolCall(JSON.stringify({
      stage: 'style',
      verdict: 'revise',
      findings: [{ section: 42, rules: [6, 'nine'], spans: ['ok', 7], reason: null }]
    }))

    expect(args?.findings).toEqual([{ section: '', rules: [6], spans: ['ok'], reason: '' }])
  })
})

describe('acceptCritique', () => {
  it('accepts a passing verdict with no findings, which is what makes an approval durable', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'pass', [])

    expect(accepted).toEqual({ ok: true, critique: { stage: 'style', verdict: 'pass', findings: [] } })
  })

  it('refuses a passing verdict that names a fault', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'pass', [
      { section: 'Deepening', reason: 'Ocean imagery.' }
    ])

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('a passing critique records no findings')
  })

  it('refuses a revising verdict that names nothing', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'revise', [])

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('at least one finding')
  })

  it(`refuses more than ${MAX_CRITIQUE_FINDINGS} findings`, () => {
    const findings = Array.from({ length: MAX_CRITIQUE_FINDINGS + 1 }, (_, i) => ({
      section: `Section ${i}`,
      reason: 'At fault.'
    }))

    const accepted = acceptCritique(bodiesOf({}), 'style', 'revise', findings)

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain(String(MAX_CRITIQUE_FINDINGS))
  })

  it('refuses the same section named twice', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'revise', [
      { section: 'Deepening', reason: 'Ocean imagery.' },
      { section: 'Deepening', reason: 'And negations.' }
    ])

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('named twice')
  })

  it('refuses a finding with no section or no reason', () => {
    expect(acceptCritique(bodiesOf({}), 'style', 'revise', [{ section: ' ', reason: 'x' }]).ok)
      .toBe(false)
    expect(acceptCritique(bodiesOf({}), 'style', 'revise', [{ section: 'A', reason: '  ' }]).ok)
      .toBe(false)
  })

  it('refuses a rule number no style rule carries, naming the range that exists', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'revise', [
      { section: 'Deepening', rules: [KNOWN_RULE, INVENTED_RULE], reason: 'Ocean imagery.' }
    ])

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('must name a style rule')
    expect(accepted.ok === false && accepted.reason).toContain(String(Math.max(...styleRuleNumbers())))
  })

  it('records a citation every one of whose numbers names a rule', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'revise', [
      { section: 'Deepening', rules: [KNOWN_RULE], reason: 'Ocean imagery.' }
    ])

    expect(accepted.ok === true && accepted.critique.findings[0].rules).toEqual([KNOWN_RULE])
  })

  it('records no rules key at all for a finding that cited none', () => {
    const accepted = acceptCritique(bodiesOf({}), 'style', 'revise', [
      { section: 'Deepening', rules: [], reason: 'Ocean imagery.' }
    ])

    expect(accepted.ok === true && accepted.critique.findings[0]).toEqual({
      section: 'Deepening',
      reason: 'Ocean imagery.'
    })
  })

  it('pins a quoted passage to the body, storing the body\'s own slice and its revision count', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY, revisions: 2 } }),
      'style',
      'revise',
      [{ section: 'Deepening', spans: ['Your body grows heavy and slow'], reason: 'Too much body.' }]
    )

    expect(accepted.ok).toBe(true)
    const finding = accepted.ok === true ? accepted.critique.findings[0] : null
    expect(finding?.spans?.[0].quote).toBe('Your body grows heavy and slow')
    expect(finding?.spans?.[0].occurrence).toBe(0)
    expect(finding?.revisions).toBe(2)
  })

  it('stores the BODY\'s own slice, not the string the model typed', () => {
    // The load-bearing rule of the whole span design. Matching folds
    // whitespace, so a model quoting across a line break types a space where
    // the body has a newline and is rightly accepted — but what gets RECORDED
    // has to be the body\'s characters. Store the typed string instead and the
    // anchor validates once, here, and then never finds itself again: the
    // reader is shown a mark on a passage that, by the rule the renderer
    // searches with, is not in the section at all.
    const typed = 'carry you down. Sink a little further, deeper than before'
    const written = typed.replace('down. Sink', 'down.\nSink')
    expect(DEEPENING_BODY).toContain(written)
    expect(DEEPENING_BODY).not.toContain(typed)

    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{ section: 'Deepening', spans: [typed], reason: 'Repetition.' }]
    )

    expect(accepted.ok).toBe(true)
    const span = accepted.ok === true ? accepted.critique.findings[0].spans?.[0] : undefined
    expect(span?.quote).toBe(written)
    // and the recorded anchor finds itself in the body it was measured against
    expect(reanchorSpan(DEEPENING_BODY, span!))
      .toMatchObject({ state: 'anchored', start: DEEPENING_BODY.indexOf(written) })
  })

  it('refuses a quote the model did not read off the section verbatim, and says it was not found', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{ section: 'Deepening', spans: ['drift down towards the ocean floor'], reason: 'Ocean imagery.' }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('was not found in "Deepening"')
  })

  it('refuses a quote too short to name a passage, and says how short it is', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{ section: 'Deepening', spans: ['Sink'], reason: 'Repetition.' }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('is 4 characters')
    expect(accepted.ok === false && accepted.reason).toContain(String(SPAN_MIN_CHARS))
  })

  it('refuses a quote that names two passages at once, and says how many', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{ section: 'Deepening', spans: ['Sink a little further'], reason: 'Repetition.' }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('appears 2 times')
  })

  it(`refuses more than ${MAX_SPANS_PER_FINDING} spans on one finding`, () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{
        section: 'Deepening',
        spans: Array.from({ length: MAX_SPANS_PER_FINDING + 1 }, () => 'Your body grows heavy'),
        reason: 'Too much body.'
      }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain(String(MAX_SPANS_PER_FINDING))
  })

  it('refuses spans against a section with no written body, rather than reporting them absent', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{ section: 'Emergence', spans: ['Your body grows heavy'], reason: 'Abrupt.' }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('has no written body')
  })

  it('records a finding about an unwritten section when it quotes nothing', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'style',
      'revise',
      [{ section: 'Emergence', reason: 'The plan never brings the listener back.' }]
    )

    expect(accepted.ok === true && accepted.critique.findings[0]).toEqual({
      section: 'Emergence',
      reason: 'The plan never brings the listener back.'
    })
  })

  it('records no revisions key on a finding that pinned no span', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY, revisions: 3 } }),
      'style',
      'revise',
      [{ section: 'Deepening', reason: 'Ocean imagery.' }]
    )

    expect(accepted.ok === true && 'revisions' in accepted.critique.findings[0]).toBe(false)
  })
})

// The outline pass judges a PLAN. Nothing is written, so a finding is a
// section and a reason — and a "quoted passage" at that point could only be a
// line of the plan passed off as a line of the script, or an invention.
describe('acceptCritique at the outline stage', () => {
  it('accepts a finding that names a section and a reason and quotes nothing', () => {
    const accepted = acceptCritique(bodiesOf({}), 'outline', 'revise', [
      { section: 'Awakening', reason: 'Nothing plants the anchor it pays off.' }
    ])

    expect(accepted).toEqual({
      ok: true,
      critique: {
        stage: 'outline',
        verdict: 'revise',
        findings: [{ section: 'Awakening', reason: 'Nothing plants the anchor it pays off.' }]
      }
    })
  })

  it('accepts an approval of the plan, so an approved plan is not an unjudged one', () => {
    expect(acceptCritique(bodiesOf({}), 'outline', 'pass', [])).toEqual({
      ok: true,
      critique: { stage: 'outline', verdict: 'pass', findings: [] }
    })
  })

  it('refuses a quoted span, and says why there is nothing to quote', () => {
    const accepted = acceptCritique(bodiesOf({}), 'outline', 'revise', [
      { section: 'Awakening', spans: ['a passage nobody has written'], reason: 'Thin.' }
    ])

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('is not written yet')
    expect(accepted.ok === false && accepted.reason).toContain('without spans')
  })

  // The refusal is about the STAGE, not about the map being empty: a body that
  // somehow exists is still no licence to quote out of it before the plan has
  // been written.
  it('refuses a span even where a body of that name exists', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'outline',
      'revise',
      [{ section: 'Deepening', spans: ['Your body grows heavy and slow'], reason: 'Thin.' }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('is not written yet')
  })

  // Every other rule still applies at this stage: the plan's own titles and a
  // citation are judged exactly as they are for a written section.
  it('still holds the finding to the rules every stage shares', () => {
    expect(acceptCritique(bodiesOf({}), 'outline', 'revise', [
      { section: 'Awakening', reason: '  ' }
    ]).ok).toBe(false)
    expect(acceptCritique(bodiesOf({}), 'outline', 'revise', [
      { section: 'Awakening', rules: [INVENTED_RULE], reason: 'Thin.' }
    ]).ok).toBe(false)
    expect(acceptCritique(bodiesOf({}), 'outline', 'pass', [
      { section: 'Awakening', reason: 'Thin.' }
    ]).ok).toBe(false)
  })
})

// The review pass judges the FINISHED script, so it quotes like the style pass
// and is refused like it.
describe('acceptCritique at the review stage', () => {
  it('pins a verbatim quote out of the section it names', () => {
    const quote = 'Your body grows heavy and slow'
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY, revisions: 2 } }),
      'review',
      'revise',
      [{ section: 'Deepening', spans: [quote], reason: 'Restates the section before it.' }]
    )

    expect(accepted.ok === true && accepted.critique.stage).toBe('review')
    expect(accepted.ok === true && accepted.critique.findings[0].spans?.[0].quote).toBe(quote)
    expect(accepted.ok === true && accepted.critique.findings[0].revisions).toBe(2)
  })

  it('accepts a whole-section finding that quotes nothing, because some faults have no passage', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'review',
      'revise',
      [{ section: 'Deepening', reason: 'The section as a whole repeats the one before it.' }]
    )

    expect(accepted.ok === true && accepted.critique.findings[0].spans).toBeUndefined()
  })

  it('refuses a quote the section does not carry', () => {
    const accepted = acceptCritique(
      bodiesOf({ Deepening: { body: DEEPENING_BODY } }),
      'review',
      'revise',
      [{ section: 'Deepening', spans: ['a sentence the section never contained'], reason: 'x' }]
    )

    expect(accepted.ok).toBe(false)
    expect(accepted.ok === false && accepted.reason).toContain('was not found in "Deepening"')
  })
})

describe('renderCritique', () => {
  it('reads an approval back as an approval, and tells the model to stop', () => {
    expect(renderCritique({ stage: 'style', verdict: 'pass', findings: [] }))
      .toBe('The style pass approved the script; nothing is marked. Stop here.')
  })

  it('reads the findings back with the pinned quotes, and says nothing was rewritten', () => {
    const rendered = renderCritique({
      stage: 'style',
      verdict: 'revise',
      findings: [{
        section: 'Deepening',
        rules: [6],
        spans: [{ quote: 'Your body grows heavy', before: '', after: '', occurrence: 0 }],
        revisions: 0,
        reason: 'Ocean imagery.'
      }]
    })

    expect(rendered).toContain('marked 1 section')
    expect(rendered).toContain('Nothing has been rewritten')
    expect(rendered).toContain('- Deepening (rule 6): Ocean imagery.')
    expect(rendered).toContain('  · "Your body grows heavy"')
  })
})

describe('findingsFromVerdicts', () => {
  const verdict = (sectionTitle: string, compliant: boolean, ruleNumbers = [KNOWN_RULE]) => ({
    sectionTitle,
    compliant,
    ruleNumbers: compliant ? [] : ruleNumbers,
    reason: compliant ? '' : 'Reason.'
  })

  it('keeps only violations for sections the script actually has', () => {
    const findings = findingsFromVerdicts(
      [verdict('Induction', true), verdict('Deepening', false), verdict('Imagined', false)],
      ['Induction', 'Deepening']
    )

    expect(findings.map(finding => finding.section)).toEqual(['Deepening'])
  })

  it('carries no spans, because a VERDICT line points at no passage', () => {
    const findings = findingsFromVerdicts([verdict('Deepening', false)], ['Deepening'])

    expect(findings[0].spans).toBeUndefined()
    expect(findings[0].revisions).toBeUndefined()
  })

  it('drops an invented rule number on the same terms the tool refuses one', () => {
    const findings = findingsFromVerdicts(
      [verdict('Deepening', false, [KNOWN_RULE, INVENTED_RULE])],
      ['Deepening']
    )

    expect(findings[0].rules).toEqual([KNOWN_RULE])
  })

  it(`caps the list at ${MAX_CRITIQUE_FINDINGS}`, () => {
    const titles = Array.from({ length: MAX_CRITIQUE_FINDINGS + 2 }, (_, i) => `S${i}`)
    const findings = findingsFromVerdicts(titles.map(t => verdict(t, false)), titles)

    expect(findings).toHaveLength(MAX_CRITIQUE_FINDINGS)
  })
})

describe('reviewRevisionsFromFindings', () => {
  it('carries the section, its rules and its reason into the report the page reads', () => {
    expect(reviewRevisionsFromFindings([
      { section: 'Deepening', rules: [6], reason: 'Ocean imagery.' },
      { section: 'Awakening', reason: 'Abrupt.' }
    ])).toEqual([
      { sectionTitle: 'Deepening', ruleNumbers: [6], reason: 'Ocean imagery.' },
      { sectionTitle: 'Awakening', reason: 'Abrupt.' }
    ])
  })
})
