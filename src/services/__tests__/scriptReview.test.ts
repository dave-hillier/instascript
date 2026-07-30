import { describe, it, expect } from 'vitest'
import {
  assessScriptLength,
  formatLengthBrief,
  parseScriptReviewResponse,
  selectScriptRevisions,
  buildScriptRevisionInstruction,
  describeRevisionReason,
  formatScriptReviewSummary,
  SCRIPT_MIN_WORDS,
  SCRIPT_MAX_WORDS,
  MAX_SCRIPT_REVIEW_REVISIONS
} from '../scriptReview'
import type { DocumentSection } from '../conversationDocument'

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

  it('reports a short script and the words needed to reach the middle of the window', () => {
    const assessment = assessScriptLength(scriptOf(2000))

    expect(assessment.status).toBe('short')
    expect(assessment.wordsToTarget).toBe(Math.round((SCRIPT_MIN_WORDS + SCRIPT_MAX_WORDS) / 2) - 2000)
    expect(assessment.wordsToTarget).toBeGreaterThan(0)
  })

  it('reports an overlong script with a negative correction', () => {
    const assessment = assessScriptLength(scriptOf(5000))

    expect(assessment.status).toBe('long')
    expect(assessment.wordsToTarget).toBeLessThan(0)
  })

  it('treats the window boundaries as on target', () => {
    expect(assessScriptLength(scriptOf(SCRIPT_MIN_WORDS)).status).toBe('on-target')
    expect(assessScriptLength(scriptOf(SCRIPT_MAX_WORDS)).status).toBe('on-target')
  })
})

describe('formatLengthBrief', () => {
  it('states the measured length, the target and the per-section counts', () => {
    const brief = formatLengthBrief(assessScriptLength([
      section('Induction', 500),
      section('Deepening', 600)
    ]))

    expect(brief).toContain('1,100 words')
    expect(brief).toContain('20-30 minutes')
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

describe('selectScriptRevisions', () => {
  const sections = [
    section('Induction', 500),
    section('Deepening', 300),
    section('Awakening', 700)
  ]

  it('rewrites only the flagged sections when the length is on target', () => {
    const onTarget = scriptOf(3300, 3)
    const verdicts = parseScriptReviewResponse(
      `VERDICT: ${onTarget[0].title} | cohesive\nVERDICT: ${onTarget[1].title} | revise | Resets the depth.`
    )

    const revisions = selectScriptRevisions(verdicts, onTarget, assessScriptLength(onTarget))

    expect(revisions).toHaveLength(1)
    expect(revisions[0].sectionTitle).toBe(onTarget[1].title)
    expect(revisions[0].issue).toBe('Resets the depth.')
    expect(revisions[0].wordTarget).toBeUndefined()
  })

  it('adds the sections with the most room when the script is short', () => {
    const assessment = assessScriptLength(sections)
    const verdicts = parseScriptReviewResponse('VERDICT: Induction | revise | Ends flat.')

    const revisions = selectScriptRevisions(verdicts, sections, assessment)

    // The flagged section first, then the shortest sections
    expect(revisions.map(revision => revision.sectionTitle)).toEqual([
      'Induction',
      'Deepening',
      'Awakening'
    ])
    // Every chosen section carries a share of the shortfall, so each grows
    for (const revision of revisions) {
      expect(revision.wordTarget).toBeGreaterThan(revision.currentWords)
    }
  })

  it('asks the longest sections to give ground when the script runs long', () => {
    const long = [section('Induction', 1800), section('Deepening', 1400), section('Awakening', 1200)]
    const revisions = selectScriptRevisions([], long, assessScriptLength(long))

    expect(revisions.map(revision => revision.sectionTitle)).toEqual([
      'Induction',
      'Deepening',
      'Awakening'
    ])
    for (const revision of revisions) {
      expect(revision.wordTarget).toBeLessThan(revision.currentWords)
    }
  })

  it('never exceeds the revision cap', () => {
    const many = scriptOf(1200, 8)
    const verdicts = parseScriptReviewResponse(
      many.map(item => `VERDICT: ${item.title} | revise | Restates the previous section.`).join('\n')
    )

    expect(selectScriptRevisions(verdicts, many, assessScriptLength(many)))
      .toHaveLength(MAX_SCRIPT_REVIEW_REVISIONS)
  })

  it('ignores verdicts for sections that are not in the script', () => {
    const onTarget = scriptOf(3300, 3)
    const verdicts = parseScriptReviewResponse('VERDICT: Imaginary Section | revise | Does not exist.')

    expect(selectScriptRevisions(verdicts, onTarget, assessScriptLength(onTarget))).toHaveLength(0)
  })
})

describe('buildScriptRevisionInstruction', () => {
  it('carries the cohesion problem into the rewrite', () => {
    const instruction = buildScriptRevisionInstruction({
      sectionTitle: 'Deepening',
      currentWords: 400,
      issue: 'Re-inducts a listener who is already deep.'
    })

    expect(instruction).toContain('Re-inducts a listener who is already deep.')
    expect(instruction).toContain('follows on from the section before it')
    expect(instruction).not.toMatch(/approximately \d+ words/)
  })

  it('states an explicit word target when the section must grow', () => {
    const instruction = buildScriptRevisionInstruction({
      sectionTitle: 'Deepening',
      currentWords: 400,
      wordTarget: 700
    })

    expect(instruction).toContain('from 400 to approximately 700 words')
    expect(instruction).toContain('rather than padding')
  })

  it('asks for cuts when the section must shrink', () => {
    const instruction = buildScriptRevisionInstruction({
      sectionTitle: 'Deepening',
      currentWords: 900,
      wordTarget: 600
    })

    expect(instruction).toContain('tighten this section')
    expect(instruction).toContain('Cut repetition')
  })
})

describe('describeRevisionReason', () => {
  it('names why the section was rewritten', () => {
    expect(describeRevisionReason({ sectionTitle: 'A', currentWords: 400, issue: 'x' })).toBe('cohesion')
    expect(describeRevisionReason({ sectionTitle: 'A', currentWords: 400, wordTarget: 700 })).toBe('length')
    expect(describeRevisionReason({ sectionTitle: 'A', currentWords: 400, issue: 'x', wordTarget: 700 }))
      .toBe('cohesion and length')
  })
})

describe('formatScriptReviewSummary', () => {
  it('reports a clean review with the final length', () => {
    const summary = formatScriptReviewSummary([], assessScriptLength(scriptOf(3300)))

    expect(summary).toContain('no cohesion problems')
    expect(summary).toContain('3,300 words')
    expect(summary).toContain('within the 20-30 minute target')
  })

  it('lists what was rewritten and why', () => {
    const summary = formatScriptReviewSummary(
      [
        { sectionTitle: 'Deepening', reason: 'cohesion' },
        { sectionTitle: 'Awakening', reason: 'length' }
      ],
      assessScriptLength(scriptOf(2000))
    )

    expect(summary).toContain('rewrote 2 sections')
    expect(summary).toContain('Deepening (cohesion)')
    expect(summary).toContain('Awakening (length)')
    expect(summary).toContain('still under the 20-30 minute target')
  })
})
