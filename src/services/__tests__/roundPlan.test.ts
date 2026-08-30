import { describe, it, expect } from 'vitest'
import {
  planNextRound,
  resolvePipeline,
  isLegacyConversation,
  MAX_ROUNDS,
  type GenerationPipeline
} from '../roundPlan'
import type { ProjectedDocument, ProjectedSection } from '../scriptProjection'
import type { GenerationRound, ScriptOutline } from '../../types/conversation'

// Hand-built projections rather than folded conversations: the planner reads
// the projection and nothing else, so these are its whole world.

const outlineOf = (...titles: string[]): ScriptOutline => ({
  title: 'Deep Rest',
  sections: titles.map(title => ({ title, description: `${title} happens here.` }))
})

const sectionOf = (title: string, truncationSuspect?: true): ProjectedSection => ({
  id: `section_${title.toLowerCase()}`,
  title,
  content: 'Breathe out slowly and let go.',
  wordCount: 6,
  ...(truncationSuspect ? { truncationSuspect } : {})
})

const documentOf = (parts: Partial<ProjectedDocument> = {}): ProjectedDocument => ({
  title: undefined,
  outline: undefined,
  sections: [],
  rounds: [],
  fullContent: '',
  ...parts
})

const roundsUpTo = (last: number, ...kinds: GenerationRound['kind'][]): GenerationRound[] =>
  kinds.map((kind, index) => ({ round: last - kinds.length + 1 + index, kind }))

const plain: GenerationPipeline = {
  outlineCritique: false, styleCritique: false, review: false, maxRounds: MAX_ROUNDS
}
const critiquing: GenerationPipeline = { ...plain, outlineCritique: true, styleCritique: true }
const full: GenerationPipeline = { ...critiquing, review: true }

describe('resolvePipeline', () => {
  it('makes the one Review pass checkbox switch on both critiques', () => {
    expect(resolvePipeline({ reviewPass: true }))
      .toEqual({ outlineCritique: true, styleCritique: true, review: false, maxRounds: MAX_ROUNDS })
  })

  it('leaves the whole-script review to its button whatever the setting says', () => {
    expect(resolvePipeline({ reviewPass: true }).review).toBe(false)
    expect(resolvePipeline({ reviewPass: false }).review).toBe(false)
  })

  it('plans nothing optional when the setting is off', () => {
    expect(resolvePipeline({ reviewPass: false }))
      .toEqual({ outlineCritique: false, styleCritique: false, review: false, maxRounds: MAX_ROUNDS })
  })
})

describe('planNextRound: numbering', () => {
  it('starts an untouched conversation at round 1', () => {
    expect(planNextRound(documentOf(), plain)).toEqual({ round: 1, kind: 'outline' })
  })

  // Counting records instead would re-issue a number already spent, and a
  // round that keeps failing would be proposed forever with maxRounds never
  // reached.
  it('advances from the last round recorded, not from how many records there are', () => {
    const document = documentOf({ rounds: [{ round: 7, kind: 'outline' }] })

    expect(planNextRound(document, plain)!.round).toBe(8)
  })

  it('stops planning once maxRounds is spent', () => {
    const document = documentOf({ rounds: [{ round: MAX_ROUNDS, kind: 'section' }] })

    expect(planNextRound(document, plain)).toBeNull()
  })

  it('plans the very last round it is allowed', () => {
    const document = documentOf({ rounds: [{ round: MAX_ROUNDS - 1, kind: 'section' }] })

    expect(planNextRound(document, plain)!.round).toBe(MAX_ROUNDS)
  })
})

describe('planNextRound: the artifact gates', () => {
  it('plans the outline while there is no plan', () => {
    expect(planNextRound(documentOf(), plain)).toEqual({ round: 1, kind: 'outline' })
  })

  it('re-plans the outline after a round that produced no plan', () => {
    const document = documentOf({ rounds: [{ round: 1, kind: 'outline' }] })

    expect(planNextRound(document, plain)).toEqual({ round: 2, kind: 'outline' })
  })

  it('plans the first section once a plan exists', () => {
    const document = documentOf({
      outline: outlineOf('Induction', 'Deepening'),
      rounds: [{ round: 1, kind: 'outline' }]
    })

    expect(planNextRound(document, plain)).toEqual({ round: 2, kind: 'section', sectionIndex: 0 })
  })

  it('plans the first section the plan names that has no body', () => {
    const document = documentOf({
      outline: outlineOf('Induction', 'Deepening', 'Awakening'),
      sections: [sectionOf('Induction'), sectionOf('Awakening')],
      rounds: roundsUpTo(3, 'outline', 'section', 'section')
    })

    expect(planNextRound(document, plain)).toEqual({ round: 4, kind: 'section', sectionIndex: 1 })
  })

  // A rejected attempt folds to no body at all, so the artifact gate re-plans
  // that index with no retry protocol of its own.
  it('re-plans a section whose only attempt was refused', () => {
    const document = documentOf({
      outline: outlineOf('Induction'),
      sections: [],
      rounds: roundsUpTo(2, 'outline', 'section')
    })

    expect(planNextRound(document, plain)).toEqual({ round: 3, kind: 'section', sectionIndex: 0 })
  })

  it('redoes a written section whose body may have been cut off', () => {
    const document = documentOf({
      outline: outlineOf('Induction', 'Awakening'),
      sections: [sectionOf('Induction'), sectionOf('Awakening', true)],
      rounds: roundsUpTo(3, 'outline', 'section', 'section')
    })

    expect(planNextRound(document, plain)).toEqual({ round: 4, kind: 'section', sectionIndex: 1 })
  })

  // The behaviour change from the old positional rule, stated as a test.
  it('does not redo the last section of a script that finished cleanly', () => {
    const document = documentOf({
      outline: outlineOf('Induction', 'Awakening'),
      sections: [sectionOf('Induction'), sectionOf('Awakening')],
      rounds: roundsUpTo(3, 'outline', 'section', 'section')
    })

    expect(planNextRound(document, plain)).toBeNull()
  })

  // Titles, not indexes: an outline critique can rewrite the plan and reorder
  // it under sections already written.
  it('matches a written body to its plan entry by title, whatever the order', () => {
    const document = documentOf({
      outline: outlineOf('Deepening', 'Induction'),
      sections: [sectionOf('Induction')],
      rounds: roundsUpTo(2, 'outline', 'section')
    })

    expect(planNextRound(document, plain)).toEqual({ round: 3, kind: 'section', sectionIndex: 0 })
  })

  it('plans a renamed section, because nothing has written the new title', () => {
    const document = documentOf({
      outline: outlineOf('Induction', 'Emergence'),
      sections: [sectionOf('Induction'), sectionOf('Awakening')],
      rounds: roundsUpTo(3, 'outline', 'section', 'section')
    })

    expect(planNextRound(document, plain)).toEqual({ round: 4, kind: 'section', sectionIndex: 1 })
  })
})

describe('planNextRound: the record gates', () => {
  const planned = documentOf({
    outline: outlineOf('Induction'),
    rounds: [{ round: 1, kind: 'outline' }]
  })
  const written = documentOf({
    outline: outlineOf('Induction'),
    sections: [sectionOf('Induction')],
    rounds: roundsUpTo(2, 'outline', 'section')
  })

  it('critiques the outline before any section is written', () => {
    expect(planNextRound(planned, critiquing))
      .toEqual({ round: 2, kind: 'outline-critique' })
  })

  // The record is the only evidence: an approving critique stores prose that
  // is indistinguishable from a stage that never ran.
  it('does not critique the outline twice', () => {
    const document = documentOf({
      ...planned,
      rounds: roundsUpTo(2, 'outline', 'outline-critique')
    })

    expect(planNextRound(document, critiquing))
      .toEqual({ round: 3, kind: 'section', sectionIndex: 0 })
  })

  // An ordering guard, not a gate: revising the plan under written prose
  // orphans the sections, and nothing here reconciles that.
  it('never critiques the outline once a section is written', () => {
    const document = documentOf({
      outline: outlineOf('Induction', 'Awakening'),
      sections: [sectionOf('Induction')],
      rounds: roundsUpTo(2, 'outline', 'section')
    })

    expect(planNextRound(document, critiquing))
      .toEqual({ round: 3, kind: 'section', sectionIndex: 1 })
  })

  it('critiques the style once every section is written', () => {
    expect(planNextRound(written, critiquing)).toEqual({ round: 3, kind: 'style-critique' })
  })

  it('does not critique the style twice', () => {
    const document = documentOf({
      ...written,
      rounds: roundsUpTo(3, 'outline', 'section', 'style-critique')
    })

    expect(planNextRound(document, critiquing)).toBeNull()
  })

  it('skips both critiques entirely when the pipeline does not ask for them', () => {
    expect(planNextRound(planned, plain)).toEqual({ round: 2, kind: 'section', sectionIndex: 0 })
    expect(planNextRound(written, plain)).toBeNull()
  })

  it('plans the whole-script review last, and only once', () => {
    const reviewed = documentOf({
      ...written,
      rounds: roundsUpTo(4, 'outline', 'section', 'style-critique', 'review')
    })

    expect(planNextRound(
      documentOf({ ...written, rounds: roundsUpTo(3, 'outline', 'section', 'style-critique') }),
      full
    )).toEqual({ round: 4, kind: 'review' })
    expect(planNextRound(reviewed, full)).toBeNull()
  })
})

describe('planNextRound: a conversation written before rounds existed', () => {
  const legacy = documentOf({
    outline: outlineOf('Induction', 'Awakening'),
    sections: [sectionOf('Induction'), sectionOf('Awakening')]
  })

  it('is recognised by having written prose and recorded no rounds', () => {
    expect(isLegacyConversation(legacy)).toBe(true)
    expect(isLegacyConversation(documentOf({ outline: outlineOf('Induction') }))).toBe(false)
    expect(isLegacyConversation(documentOf({ ...legacy, rounds: [{ round: 1, kind: 'outline' }] })))
      .toBe(false)
  })

  // Without this, opening a finished pre-round script and pressing resume
  // would re-run a style critique that already ran, every time, forever.
  it('has its record gates treated as already satisfied', () => {
    expect(planNextRound(legacy, critiquing)).toBeNull()
    expect(planNextRound(legacy, full)).toBeNull()
  })

  // Its artifact gates still apply, which is what lets an old half-finished
  // script resume at the right section instead of starting over.
  it('still resumes at the first section its plan has no body for', () => {
    const half = documentOf({
      outline: outlineOf('Induction', 'Deepening', 'Awakening'),
      sections: [sectionOf('Induction')]
    })

    expect(planNextRound(half, critiquing)).toEqual({ round: 1, kind: 'section', sectionIndex: 1 })
  })

  it('still writes an outline for a conversation that has neither plan nor prose', () => {
    expect(planNextRound(documentOf(), critiquing)).toEqual({ round: 1, kind: 'outline' })
  })
})
