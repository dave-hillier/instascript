import { describe, it, expect } from 'vitest'
import { buildProgressRows } from '../scriptProgress'

const outlineOf = (...titles: string[]) => ({
  sections: titles.map(title => ({ title }))
})

const sectionsOf = (...pairs: [string, number][]) =>
  pairs.map(([title, wordCount]) => ({ title, wordCount }))

describe('buildProgressRows', () => {
  it('lists the written sections when there is no plan', () => {
    const rows = buildProgressRows(sectionsOf(['Induction', 120], ['Emergence', 90]), null)

    expect(rows).toEqual([
      { title: 'Induction', wordCount: 120, state: 'complete' },
      { title: 'Emergence', wordCount: 90, state: 'complete' }
    ])
  })

  it('shows planned sections that are not written yet, in outline order', () => {
    const rows = buildProgressRows(sectionsOf(['Induction', 120]), {
      phase: 'generating_section',
      currentSectionIndex: 1,
      outline: outlineOf('Induction', 'Deepening', 'Emergence')
    })

    expect(rows.map(row => [row.title, row.state])).toEqual([
      ['Induction', 'complete'],
      ['Deepening', 'active'],
      ['Emergence', 'pending']
    ])
  })

  it('marks the section being written as active once its words start arriving', () => {
    const rows = buildProgressRows(sectionsOf(['Induction', 120], ['Deepening', 30]), {
      phase: 'generating_section',
      currentSectionIndex: 1,
      outline: outlineOf('Induction', 'Deepening', 'Emergence')
    })

    expect(rows.find(row => row.title === 'Deepening')).toEqual({
      title: 'Deepening',
      wordCount: 30,
      state: 'active'
    })
  })

  it('shows a section added after the outline was drawn, in its document position', () => {
    const rows = buildProgressRows(
      sectionsOf(['Induction', 120], ['Drift', 80], ['Emergence', 90]),
      { phase: 'complete', currentSectionIndex: 2, outline: outlineOf('Induction', 'Emergence') }
    )

    expect(rows.map(row => row.title)).toEqual(['Induction', 'Drift', 'Emergence'])
    expect(rows.find(row => row.title === 'Drift')?.wordCount).toBe(80)
  })

  it('shows a renamed section under its new title, alongside the plan it replaced', () => {
    const rows = buildProgressRows(
      sectionsOf(['Induction', 120], ['Deep Drift', 80]),
      { phase: 'complete', currentSectionIndex: 2, outline: outlineOf('Induction', 'Deepening') }
    )

    expect(rows.map(row => [row.title, row.state])).toEqual([
      ['Induction', 'complete'],
      ['Deepening', 'empty'],
      ['Deep Drift', 'complete']
    ])
  })

  it('tracks the active section by title, so an inserted section does not shift it', () => {
    const rows = buildProgressRows(
      sectionsOf(['Induction', 120], ['Drift', 80], ['Deepening', 10]),
      {
        phase: 'generating_section',
        currentSectionIndex: 1,
        outline: outlineOf('Induction', 'Deepening', 'Emergence')
      }
    )

    expect(rows.map(row => [row.title, row.state])).toEqual([
      ['Induction', 'complete'],
      ['Drift', 'complete'],
      ['Deepening', 'active'],
      ['Emergence', 'pending']
    ])
  })

  it('leaves an unwritten plan empty rather than pending once the run has settled', () => {
    const rows = buildProgressRows(sectionsOf(['Induction', 120]), {
      phase: 'error',
      currentSectionIndex: 1,
      outline: outlineOf('Induction', 'Deepening')
    })

    expect(rows.map(row => [row.title, row.state])).toEqual([
      ['Induction', 'complete'],
      ['Deepening', 'empty']
    ])
  })

  it('returns nothing when neither the plan nor the document has sections', () => {
    expect(buildProgressRows([], { phase: 'idle', currentSectionIndex: 0, outline: null })).toEqual([])
  })
})
