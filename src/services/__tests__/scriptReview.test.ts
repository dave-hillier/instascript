import { describe, it, expect } from 'vitest'
import {
  assessScriptLength,
  formatLengthBrief,
  parseScriptReviewResponse,
  findingsFromReviewVerdicts,
  formatScriptReviewSummary
} from '../scriptReview'
import { MAX_CRITIQUE_FINDINGS } from '../critiquePass'
import { buildLengthPlan } from '../scriptLength'
import type { DocumentSection } from '../conversationDocument'

// The default target every assessment below is judged against
const defaultPlan = buildLengthPlan()

const words = (count: number): string =>
  Array.from({ length: count }, (_, i) => `w${i}`).join(' ')

const section = (title: string, wordCount: number): DocumentSection =>
  ({ title, content: words(wordCount) })

// A script whose sections total exactly `total` words, spread evenly
const scriptOf = (total: number, sectionCount = 6): DocumentSection[] => {
  const per = Math.floor(total / sectionCount)
  return Array.from({ length: sectionCount }, (_, i) =>
    section(`Section ${i + 1}`, i === sectionCount - 1 ? total - per * (sectionCount - 1) : per)
  )
}

describe('assessScriptLength', () => {
  it('reports a script inside the spoken-duration window as on target', () => {
    const assessment = assessScriptLength(scriptOf(3300))

    expect(assessment.totalWords).toBe(3300)
    expect(assessment.status).toBe('on-target')
    expect(assessment.wordsToTarget).toBe(0)
    expect(assessment.minutes).toBe(Math.round(3300 / 130))
  })

  it('reports a short script and the words needed to reach the target', () => {
    const assessment = assessScriptLength(scriptOf(2000))

    expect(assessment.status).toBe('short')
    expect(assessment.wordsToTarget).toBe(defaultPlan.totalWords - 2000)
    expect(assessment.wordsToTarget).toBeGreaterThan(0)
  })

  it('reports an overlong script with a negative correction', () => {
    const assessment = assessScriptLength(scriptOf(5000))

    expect(assessment.status).toBe('long')
    expect(assessment.wordsToTarget).toBeLessThan(0)
  })

  it('treats the window boundaries as on target', () => {
    expect(assessScriptLength(scriptOf(defaultPlan.minWords)).status).toBe('on-target')
    expect(assessScriptLength(scriptOf(defaultPlan.maxWords)).status).toBe('on-target')
  })
})

describe('assessScriptLength against a requested length', () => {
  it('judges the same script against whatever length was asked for', () => {
    const script = scriptOf(1500)

    expect(assessScriptLength(script, buildLengthPlan(12)).status).toBe('on-target')
    expect(assessScriptLength(script, buildLengthPlan(40)).status).toBe('short')
  })
})

describe('formatLengthBrief', () => {
  it('states the measured length, the target and the per-section counts', () => {
    const brief = formatLengthBrief(assessScriptLength([
      section('Induction', 500),
      section('Deepening', 600)
    ]))

    expect(brief).toContain('1,100 words')
    expect(brief).toContain(`about ${defaultPlan.targetMinutes} minutes`)
    expect(brief).toContain('- "Induction": 500 words')
    expect(brief).toContain('- "Deepening": 600 words')
    expect(brief).toContain('short')
  })
})

describe('parseScriptReviewResponse', () => {
  it('parses cohesive and revise verdicts, skipping commentary', () => {
    const verdicts = parseScriptReviewResponse([
      'Here is my review of the script as a whole:',
      'VERDICT: Induction | cohesive',
      'VERDICT: Deepening | revise | Repeats the breathing imagery of the induction.',
      'Some stray commentary that is not a verdict.'
    ].join('\n'))

    expect(verdicts).toEqual([
      { sectionTitle: 'Induction', cohesive: true, issue: '' },
      {
        sectionTitle: 'Deepening',
        cohesive: false,
        issue: 'Repeats the breathing imagery of the induction.'
      }
    ])
  })

  it('keeps the first verdict per section and skips malformed lines', () => {
    const verdicts = parseScriptReviewResponse([
      'VERDICT: Induction | cohesive',
      'VERDICT: Induction | revise | changed my mind',
      'VERDICT: Deepening | maybe fine',
      'VERDICT: Awakening'
    ].join('\n'))

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ sectionTitle: 'Induction', cohesive: true })
  })
})

describe('findingsFromReviewVerdicts', () => {
  const titles = ['Induction', 'Deepening', 'Awakening']

  it('records one finding per section the review would not call cohesive', () => {
    const verdicts = parseScriptReviewResponse([
      'VERDICT: Induction | cohesive',
      'VERDICT: Deepening | revise | Re-inducts a listener who is already deep.'
    ].join('\n'))

    expect(findingsFromReviewVerdicts(verdicts, titles)).toEqual([
      { section: 'Deepening', reason: 'Re-inducts a listener who is already deep.' }
    ])
  })

  it('quotes nothing, because a VERDICT line points at no passage', () => {
    const verdicts = parseScriptReviewResponse('VERDICT: Deepening | revise | Resets the depth.')

    for (const finding of findingsFromReviewVerdicts(verdicts, titles)) {
      expect(finding.spans).toBeUndefined()
      expect(finding.rules).toBeUndefined()
    }
  })

  it('drops a verdict naming a section the script does not have', () => {
    const verdicts = parseScriptReviewResponse('VERDICT: Imaginary Section | revise | Does not exist.')

    expect(findingsFromReviewVerdicts(verdicts, titles)).toEqual([])
  })

  it('says so rather than recording a silent finding when the review gave no reason', () => {
    const verdicts = parseScriptReviewResponse('VERDICT: Deepening | revise')

    expect(findingsFromReviewVerdicts(verdicts, titles)[0].reason)
      .toBe('The review marked this section without saying why.')
  })

  it('never records more findings than a critique may carry', () => {
    const many = scriptOf(1200, 8)
    const verdicts = parseScriptReviewResponse(
      many.map(item => `VERDICT: ${item.title} | revise | Restates the previous section.`).join('\n')
    )

    expect(findingsFromReviewVerdicts(verdicts, many.map(item => item.title)))
      .toHaveLength(MAX_CRITIQUE_FINDINGS)
  })
})

describe('formatScriptReviewSummary', () => {
  it('reports a clean review with the final length', () => {
    const summary = formatScriptReviewSummary([], assessScriptLength(scriptOf(3300)))

    expect(summary).toContain('no cohesion problems')
    expect(summary).toContain('3,300 words')
    expect(summary).toContain(`close to the ${defaultPlan.targetMinutes} minute target`)
  })

  it('lists what was MARKED, and says plainly that nothing was rewritten', () => {
    const summary = formatScriptReviewSummary(
      [
        { sectionTitle: 'Deepening', reason: 'Re-inducts an already deep listener.' },
        { sectionTitle: 'Awakening', reason: 'Never pays off the anchor.' }
      ],
      assessScriptLength(scriptOf(2000))
    )

    expect(summary).toContain('marked 2 sections')
    expect(summary).toContain('Nothing was rewritten')
    expect(summary).not.toContain('rewrote')
    expect(summary).toContain('Deepening (Re-inducts an already deep listener.)')
    expect(summary).toContain('Awakening (Never pays off the anchor.)')
    expect(summary).toContain(`under the ${defaultPlan.targetMinutes} minute target`)
  })
})
