import { describe, it, expect } from 'vitest'
import {
  documentMarkView,
  findingLabel,
  findingOrigin,
  markRenderId,
  focusedRunKey,
  markPlacementNote,
  spendCostNote,
  type MarkableSection,
  type SectionMark
} from '../sectionMarkView'
import { anchorFields, resolveSpan } from '../span'
import { findingKey, type ReaderFlag } from '../markStore'
import type { ProjectedFinding } from '../scriptProjection'

// Long enough that every quote below clears SPAN_MIN_CHARS and is unique in the
// body, which is what the span layer requires of a passage before it will pin
// one at all.
const BODY = [
  '## Settling',
  'Let the shoulders drop away from the ears, and notice the weight of the hands.',
  'The breath moves on its own, without any help from you at all.'
].join('\n')

const section = (overrides: Partial<MarkableSection> = {}): MarkableSection => ({
  id: 'settling',
  title: 'Settling',
  content: BODY,
  ...overrides
})

// A span pinned the way acceptance pins one: sliced out of the body, never
// copied from the claim.
const spanFor = (body: string, quote: string) => {
  const resolved = resolveSpan(body, quote)
  if (!resolved.ok) throw new Error(`test span did not pin: ${resolved.fault}`)
  return resolved.anchor
}

const finding = (overrides: Partial<ProjectedFinding> = {}): ProjectedFinding => ({
  stage: 'style',
  section: 'Settling',
  reason: 'The image repeats the opening',
  ...overrides
})

const flag = (overrides: Partial<ReaderFlag> = {}): ReaderFlag => ({
  id: 'flag-1',
  section: 'Settling',
  anchor: spanFor(BODY, 'the weight of the hands'),
  revisions: 0,
  label: 'Too abstract',
  createdAt: 1000,
  ...overrides
})

const view = (input: Partial<Parameters<typeof documentMarkView>[0]> = {}) =>
  documentMarkView({
    sections: [section()],
    findings: [],
    flags: [],
    dismissed: [],
    spent: [],
    canSpend: true,
    focusedMarkId: null,
    ...input
  })

const runTexts = (marks: ReturnType<typeof documentMarkView>, title = 'Settling') =>
  (marks.bySection[title]?.paragraphs ?? []).map(paragraph =>
    paragraph.runs.map(run => ({ text: run.text, markIds: run.markIds, tone: run.tone }))
  )

const markById = (marks: SectionMark[], id: string): SectionMark => {
  const found = marks.find(mark => mark.id === id)
  if (!found) throw new Error(`no mark ${id}`)
  return found
}

describe('sectionMarkView', () => {
  describe('a section with nothing marked', () => {
    it('renders the paragraphs it always rendered, one run each', () => {
      expect(runTexts(view())).toEqual([
        [{
          text: 'Let the shoulders drop away from the ears, and notice the weight of the hands.',
          markIds: [],
          tone: 'plain'
        }],
        [{
          text: 'The breath moves on its own, without any help from you at all.',
          markIds: [],
          tone: 'plain'
        }]
      ])
    })

    // The heading is drawn by the section header, and a blank line is not a
    // paragraph. Both were already dropped before marks existed, and the
    // offsets have to be measured against a body that still contains them.
    it('leaves out the heading line and the blank lines', () => {
      const marks = view({
        sections: [section({ content: '## Settling\n\nOne paragraph only, and it is this one.\n' })]
      })

      expect(runTexts(marks)).toEqual([
        [{ text: 'One paragraph only, and it is this one.', markIds: [], tone: 'plain' }]
      ])
    })
  })

  describe('a passage a model quoted', () => {
    const quoted = finding({
      rules: [4],
      spans: [spanFor(BODY, 'The breath moves on its own')],
      revisions: 0
    })

    it('cuts the paragraph at the quoted passage', () => {
      const marks = view({ findings: [quoted] })
      const id = marks.marks[0]?.id

      expect(runTexts(marks)[1]).toEqual([
        { text: 'The breath moves on its own', markIds: [id], tone: 'finding' },
        { text: ', without any help from you at all.', markIds: [], tone: 'plain' }
      ])
    })

    it('names it by the rule it cites, and carries the reason through', () => {
      const mark = view({ findings: [quoted] }).marks[0]

      expect(mark?.kind).toBe('finding')
      expect(mark?.label).toBe('Style rule 4')
      expect(mark?.reason).toBe('The image repeats the opening')
      expect(mark?.placement).toBe('anchored')
      expect(mark?.key).toBe(findingKey(quoted, 'style'))
    })

    it('leaves a dismissed finding out of the view entirely', () => {
      const marks = view({ findings: [quoted], dismissed: [findingKey(quoted, 'style')] })

      expect(marks.marks).toEqual([])
      expect(runTexts(marks)[1]?.[0]?.markIds).toEqual([])
    })

    // The passage is gone from the body. Drawing nothing and saying nothing
    // would leave the reader believing it had been repaired.
    it('keeps a finding whose passage has gone, with nowhere to draw it', () => {
      const marks = view({
        sections: [section({ content: '## Settling\nEntirely different words now, rather longer.' })],
        findings: [quoted]
      })

      expect(marks.marks[0]?.placement).toBe('stale')
      expect(marks.marks[0]?.ranges).toEqual([])
      expect(markPlacementNote(markById(marks.marks, marks.marks[0]?.id ?? ''))).not.toBeNull()
    })

    it('says so when the body was replaced under a passage that survived it', () => {
      const marks = view({
        sections: [section({ revisions: 2 })],
        findings: [quoted]
      })

      expect(marks.marks[0]?.rewrittenSince).toBe(true)
      expect(marks.marks[0]?.placement).toBe('anchored')
    })

    it('does not claim a rewrite when the count is where the finding left it', () => {
      expect(view({ sections: [section({ revisions: 0 })], findings: [quoted] }).marks[0]?.rewrittenSince)
        .toBe(false)
    })

    // A prose critique points at no passage at all, and neither does a finding
    // about a section nobody has written yet.
    it('keeps a finding that quoted nothing', () => {
      const marks = view({ findings: [finding()] })

      expect(marks.marks[0]?.placement).toBe('unquoted')
      expect(marks.marks[0]?.quotes).toEqual([])
      expect(runTexts(marks)[0]?.[0]?.markIds).toEqual([])
    })

    // Dropping it would hide a judgement the model actually made.
    it('lists a finding against a section the script does not have, last and unspendable', () => {
      const marks = view({
        findings: [finding({ section: 'Closing', reason: 'Never written' }), finding()]
      })

      expect(marks.marks.map(mark => mark.section)).toEqual(['Settling', 'Closing'])
      expect(marks.marks[1]?.spendable).toBe(false)
      expect(marks.bySection.Closing).toBeUndefined()
    })
  })

  describe('a passage the reader flagged', () => {
    it('is drawn as the reader\'s own, with their label', () => {
      const marks = view({ flags: [flag()] })

      expect(marks.marks[0]?.kind).toBe('flag')
      expect(marks.marks[0]?.label).toBe('Too abstract')
      expect(marks.marks[0]?.key).toBe('flag-1')
      expect(runTexts(marks)[0]).toEqual([
        { text: 'Let the shoulders drop away from the ears, and notice ', markIds: [], tone: 'plain' },
        { text: 'the weight of the hands', markIds: [marks.marks[0]?.id], tone: 'flag' },
        { text: '.', markIds: [], tone: 'plain' }
      ])
    })

    it('carries the reader\'s note as its reason', () => {
      expect(view({ flags: [flag({ note: 'It said this a moment ago' })] }).marks[0]?.reason)
        .toBe('It said this a moment ago')
    })
  })

  describe('marks that overlap', () => {
    // The hard case. Nested elements have no accessible name between them and
    // one mark quietly winning would hide the other, so the body is cut at
    // every boundary and the shared stretch says it belongs to both.
    it('gives the shared stretch to both marks and hides neither', () => {
      const marks = view({
        findings: [finding({
          spans: [spanFor(BODY, 'notice the weight of the hands')],
          rules: [4]
        })],
        // Begins inside the finding's passage and ends one character past it,
        // so neither mark contains the other
        flags: [flag({
          anchor: anchorFields(
            BODY,
            BODY.indexOf('the weight'),
            BODY.indexOf('the weight') + 'the weight of the hands.'.length
          )
        })]
      })

      const findingId = marks.marks.find(mark => mark.kind === 'finding')?.id
      const flagId = marks.marks.find(mark => mark.kind === 'flag')?.id

      expect(runTexts(marks)[0]).toEqual([
        { text: 'Let the shoulders drop away from the ears, and ', markIds: [], tone: 'plain' },
        { text: 'notice ', markIds: [findingId], tone: 'finding' },
        { text: 'the weight of the hands', markIds: [findingId, flagId], tone: 'both' },
        { text: '.', markIds: [flagId], tone: 'flag' }
      ])
    })

    it('orders marks by where they begin, so the panel reads down the page', () => {
      const marks = view({
        findings: [finding({ spans: [spanFor(BODY, 'The breath moves on its own')] })],
        flags: [flag()]
      })

      expect(marks.marks.map(mark => mark.kind)).toEqual(['flag', 'finding'])
      expect(marks.marks.map(mark => mark.id))
        .toEqual(marks.marks.map(mark => markRenderId(mark.key)))
    })

    it('gives a mark that has nowhere to sit an id after the ones that do', () => {
      const marks = view({
        findings: [finding({ reason: 'No passage' })],
        flags: [flag()]
      })

      expect(marks.marks.map(mark => mark.placement)).toEqual(['anchored', 'unquoted'])
    })
  })

  describe('a finding that quoted the same phrase twice', () => {
    const twice = '## Settling\nThe shoulders drop away, and the hands rest.\nThe breath moves on its own, easily now.'

    it('draws every passage it named, as one mark', () => {
      const marks = documentMarkView({
        sections: [section({ content: twice })],
        findings: [finding({
          spans: [
            spanFor(twice, 'The shoulders drop away'),
            spanFor(twice, 'The breath moves on its own')
          ]
        })],
        flags: [],
        dismissed: [],
        spent: [],
        canSpend: true,
        focusedMarkId: null
      })

      expect(marks.marks).toHaveLength(1)
      expect(marks.marks[0]?.ranges).toHaveLength(2)
      expect(runTexts(marks).map(runs => runs.filter(run => run.markIds.length > 0).map(run => run.text)))
        .toEqual([['The shoulders drop away'], ['The breath moves on its own']])
    })

    it('reports the whole mark stale only when every passage has gone', () => {
      const marks = documentMarkView({
        sections: [section({ content: '## Settling\nThe breath moves on its own, easily now.' })],
        findings: [finding({
          spans: [
            spanFor(twice, 'The shoulders drop away'),
            spanFor(twice, 'The breath moves on its own')
          ]
        })],
        flags: [],
        dismissed: [],
        spent: [],
        canSpend: true,
        focusedMarkId: null
      })

      expect(marks.marks[0]?.placement).toBe('anchored')
      expect(marks.marks[0]?.ranges).toHaveLength(1)
    })
  })

  describe('a section still being written', () => {
    // Its body is a fragment: a passage found in it means nothing, and a
    // passage missing from it proves nothing. Marks are set aside rather than
    // recomputed against a half-written body (M4).
    it('draws no marks over it and says why', () => {
      const marks = view({
        sections: [section({ isLive: true, revisions: 1 })],
        findings: [finding({ spans: [spanFor(BODY, 'The breath moves on its own')], revisions: 0 })],
        flags: [flag()]
      })

      expect(marks.marks.map(mark => mark.placement)).toEqual(['unsettled', 'unsettled'])
      expect(runTexts(marks).flat().every(run => run.markIds.length === 0)).toBe(true)
      expect(markPlacementNote(markById(marks.marks, marks.marks[0]?.id ?? '')))
        .toContain('being written')
    })
  })

  describe('the element a mark is drawn in', () => {
    // One mark can be cut across several runs by another overlapping it, so
    // the panel is told which run carries it rather than assuming the mark and
    // the element are one to one.
    it('is the first run the mark covers', () => {
      const marks = view({ flags: [flag()] })
      const mark = marks.marks[0]
      const carrier = marks.bySection.Settling?.paragraphs[0]?.runs.find(
        run => run.markIds.length > 0
      )

      expect(mark?.anchorRunKey).toBe(carrier?.key)
      expect(focusedRunKey(marks.marks, mark?.id ?? null)).toBe(carrier?.key)
    })

    it('is nothing for a mark with no passage left to show', () => {
      const marks = view({ findings: [finding()] })

      expect(marks.marks[0]?.anchorRunKey).toBeUndefined()
      expect(focusedRunKey(marks.marks, marks.marks[0]?.id ?? null)).toBeNull()
    })

    it('is nothing when no mark is focused', () => {
      expect(focusedRunKey(view({ flags: [flag()] }).marks, null)).toBeNull()
    })

    // Two sections both start their run keys at the first paragraph, so a key
    // that did not name its section would collide as an element id.
    it('names its section, so two sections cannot share an element id', () => {
      const other = section({ id: 'closing', title: 'Closing' })
      const marks = documentMarkView({
        sections: [section(), other],
        findings: [],
        flags: [],
        dismissed: [],
        spent: [],
        canSpend: true,
        focusedMarkId: null
      })
      const keys = Object.values(marks.bySection)
        .flatMap(sectionView => sectionView.paragraphs.flatMap(paragraph => paragraph.runs.map(run => run.key)))

      expect(new Set(keys).size).toBe(keys.length)
    })
  })

  describe('what spending a mark would cost', () => {
    it('is said before it is spent, in rewrites of this section', () => {
      expect(spendCostNote(section())).toBe('A first rewrite of "Settling"')
      expect(spendCostNote(section({ revisions: 1 })))
        .toBe('The 2nd rewrite of "Settling" — it has been rewritten once already')
      expect(spendCostNote(section({ revisions: 3 })))
        .toBe('The 4th rewrite of "Settling" — it has been rewritten 3 times already')
    })

    it('rides on the mark, so the button can show it', () => {
      expect(view({ sections: [section({ revisions: 2 })], flags: [flag()] }).marks[0]?.spendNote)
        .toBe('The 3rd rewrite of "Settling" — it has been rewritten 2 times already')
    })

    it('carries an instruction naming the passage and the reason', () => {
      const mark = view({ flags: [flag({ note: 'It said this a moment ago' })] }).marks[0]

      expect(mark?.instruction).toBe(
        'Too abstract. Rewrite this passage: "the weight of the hands" — It said this a moment ago'
      )
    })

    it('falls back to the reader having marked it when they wrote no note', () => {
      expect(view({ flags: [flag()] }).marks[0]?.instruction)
        .toContain('the reader marked it')
    })
  })

  describe('naming a finding', () => {
    it('cites the rules where there are any', () => {
      expect(findingLabel(finding({ rules: [4] }))).toBe('Style rule 4')
      expect(findingLabel(finding({ rules: [4, 7] }))).toBe('Style rules 4, 7')
    })

    it('names the pass otherwise', () => {
      expect(findingLabel(finding())).toBe('Style note')
      expect(findingLabel(finding({ stage: 'outline' }))).toBe('Outline note')
      expect(findingLabel(finding({ stage: 'review' }))).toBe('Review note')
    })
  })

  describe('what the reader is told about a mark', () => {
    const mark = (overrides: Partial<SectionMark>): SectionMark => ({
      id: markRenderId('k'),
      key: 'k',
      kind: 'finding',
      section: 'Settling',
      label: 'Style note',
      origin: 'From the style pass',
      reason: 'because',
      quotes: [],
      ranges: [],
      placement: 'anchored',
      rewrittenSince: false,
      instruction: '',
      spendNote: '',
      spendable: true,
      ...overrides
    })

    it('says nothing about a mark sitting on its passage in an untouched body', () => {
      expect(markPlacementNote(mark({}))).toBeNull()
    })

    it('separates a passage that survived a rewrite from one that was never touched', () => {
      expect(markPlacementNote(mark({ rewrittenSince: true }))).toContain('survived')
    })

    it('separates a passage lost to a rewrite from one that simply is not there', () => {
      expect(markPlacementNote(mark({ placement: 'stale', rewrittenSince: true })))
        .toContain('rewritten since')
      expect(markPlacementNote(mark({ placement: 'stale' })))
        .toBe('The passage is no longer in this section.')
    })

    it('says a shifted passage is a guess', () => {
      expect(markPlacementNote(mark({ placement: 'shifted' }))).toContain('only copy')
    })
  })
  // M1: the ids used to be `${section.id}_mark_${index}`. The focus state and
  // the panel's open rename form are both held against the id, so an id that
  // counted positions named a different mark the moment the list reordered or
  // shortened — and the rename saved the reader's label onto whoever had
  // moved into that slot.
  describe('a mark keeping its identity as the list moves', () => {
    const early = spanFor(BODY, 'the weight of the hands')
    const late = spanFor(BODY, 'The breath moves on its own')

    it('names a mark after what it is, not where it sits', () => {
      // The same finding and the same flag throughout. Only the flag's passage
      // moves — from after the finding's to before it — which is enough to
      // swap the two in the list.
      const judged = finding({ spans: [early] })
      const after = view({ findings: [judged], flags: [flag({ anchor: late })] })
      const before = view({
        findings: [judged],
        flags: [flag({ anchor: spanFor(BODY, 'Let the shoulders drop away from the ears') })]
      })

      expect(after.marks.map(mark => mark.kind)).toEqual(['finding', 'flag'])
      expect(before.marks.map(mark => mark.kind)).toEqual(['flag', 'finding'])
      expect(before.marks.find(mark => mark.kind === 'flag')?.id)
        .toBe(after.marks.find(mark => mark.kind === 'flag')?.id)
      expect(before.marks.find(mark => mark.kind === 'finding')?.id)
        .toBe(after.marks.find(mark => mark.kind === 'finding')?.id)
    })

    it('does not hand a dropped mark\'s id to the mark that follows it', () => {
      const quoted = finding({ spans: [late] })
      const both = view({ findings: [quoted], flags: [flag()] })
      const findingId = both.marks.find(mark => mark.kind === 'finding')?.id

      const afterFlagWentFirst = view({ findings: [quoted] })

      expect(afterFlagWentFirst.marks[0]?.id).toBe(findingId)
      expect(afterFlagWentFirst.marks[0]?.id)
        .not.toBe(both.marks.find(mark => mark.kind === 'flag')?.id)
    })

    it('gives an id that can be written into an attribute and read back out', () => {
      const id = view({ findings: [finding({ spans: [late] })] }).marks[0]?.id ?? ''

      // Ids travel through aria-controls and space-separated token lists, and
      // a finding's key carries the model's own prose and a unit separator.
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it('draws one mark for two findings nothing can tell apart', () => {
      const twin = finding({ spans: [late] })
      const marks = view({ findings: [twin, { ...twin }] })

      expect(marks.marks).toHaveLength(1)
    })
  })

  // M2: this used to be `canSpend && mark.spendable` in the panel's JSX, with
  // nothing testing it. A rewrite asked for against a body being replaced
  // under it is the wrongness the whole feature exists to remove.
  describe('whether a mark can be spent', () => {
    it('offers a rewrite where there is a section and no run in flight', () => {
      expect(view({ flags: [flag()] }).marks[0]?.spendable).toBe(true)
    })

    it('offers none while the run is writing', () => {
      expect(view({ flags: [flag()], canSpend: false }).marks[0]?.spendable).toBe(false)
    })

    it('offers none on a finding naming a section the script does not have', () => {
      const orphan = view({ findings: [finding({ section: 'Nowhere' })] })

      expect(orphan.marks[0]?.spendable).toBe(false)
    })

    it('still says what a rewrite would cost, so the panel can explain itself', () => {
      expect(view({ flags: [flag()], canSpend: false }).marks[0]?.spendNote)
        .toBe(spendCostNote(section()))
    })
  })

  // M8: the panel hard-coded "From the style pass" for every finding, in JSX.
  // critique_record accepts the outline and review stages too.
  describe('who made a mark', () => {
    it('names the pass a finding came from', () => {
      expect(findingOrigin(finding())).toBe('From the style pass')
      expect(findingOrigin(finding({ stage: 'outline' }))).toBe('From the outline pass')
      expect(findingOrigin(finding({ stage: 'review' }))).toBe('From the review pass')
    })

    it('carries the origin on the mark itself', () => {
      const marks = view({
        findings: [finding({ stage: 'review', spans: [spanFor(BODY, 'The breath moves on its own')] })],
        flags: [flag()]
      })

      expect(marks.marks.map(mark => mark.origin)).toEqual(['Your mark', 'From the review pass'])
    })
  })

  // M7: the reading view used to decide both of these in its JSX, one of them
  // by comparing mark ids against '' when nothing was focused.
  describe('what a drawn run says about itself', () => {
    const findingSpan = spanFor(BODY, 'the weight of the hands')

    it('marks the runs the focused mark covers, and only those', () => {
      const marks = view({ findings: [finding({ spans: [findingSpan] })], flags: [] })
      const focused = view({
        findings: [finding({ spans: [findingSpan] })],
        focusedMarkId: marks.marks[0]?.id ?? null
      })
      const runs = (focused.bySection.Settling?.paragraphs ?? []).flatMap(p => p.runs)

      expect(runs.filter(run => run.focused).map(run => run.text))
        .toEqual(['the weight of the hands'])
    })

    it('focuses nothing when nothing is focused', () => {
      const runs = (view({ findings: [finding({ spans: [findingSpan] })] })
        .bySection.Settling?.paragraphs ?? []).flatMap(p => p.runs)

      expect(runs.some(run => run.focused)).toBe(false)
    })

    it('says in words what covers a marked stretch, for a reader who cannot see it', () => {
      const marks = view({ findings: [finding({ spans: [findingSpan], rules: [4] })] })
      const marked = (marks.bySection.Settling?.paragraphs ?? [])
        .flatMap(p => p.runs)
        .find(run => run.markIds.length > 0)

      expect(marked?.announcement).toBe('Marked passage: From the style pass — Style rule 4.')
    })

    it('names both marks where two cover the same words', () => {
      const marks = view({
        findings: [finding({ spans: [spanFor(BODY, 'notice the weight of the hands')] })],
        flags: [flag()]
      })
      const both = (marks.bySection.Settling?.paragraphs ?? [])
        .flatMap(p => p.runs)
        .find(run => run.markIds.length === 2)

      expect(both?.announcement).toBe(
        'Marked passage: From the style pass — Style note; Your mark — Too abstract.'
      )
    })

    it('leaves plain prose to be read as prose', () => {
      const runs = (view().bySection.Settling?.paragraphs ?? []).flatMap(p => p.runs)

      expect(runs.every(run => run.announcement === '')).toBe(true)
    })
  })

  // M4: a finding the reader paid a rewrite for is not one they dismissed. It
  // is hidden like one, but there is nothing to restore it to.
  describe('a finding already spent on a rewrite', () => {
    it('is not drawn again', () => {
      const quoted = finding({ spans: [spanFor(BODY, 'the weight of the hands')] })

      expect(view({ findings: [quoted], spent: [findingKey(quoted, 'style')] }).marks).toEqual([])
    })
  })
})
