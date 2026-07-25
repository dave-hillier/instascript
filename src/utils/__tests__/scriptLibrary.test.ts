import { describe, it, expect } from 'vitest'
import type { Script } from '../../types/script'
import {
  parseSortOrder,
  getScriptTimestamp,
  filterScriptsByQuery,
  sortScriptsByCreation,
  duplicateScriptStatus
} from '../scriptLibrary'

const makeScript = (overrides: Partial<Script>): Script => ({
  id: 'script_1000_abc',
  title: 'Untitled',
  content: '',
  createdAt: '2026-01-01',
  isArchived: false,
  ...overrides
})

describe('parseSortOrder', () => {
  it('returns oldest only for the exact value', () => {
    expect(parseSortOrder('oldest')).toBe('oldest')
  })

  it('falls back to newest for null, empty and unknown values', () => {
    expect(parseSortOrder(null)).toBe('newest')
    expect(parseSortOrder('')).toBe('newest')
    expect(parseSortOrder('sideways')).toBe('newest')
  })
})

describe('getScriptTimestamp', () => {
  it('extracts the epoch milliseconds embedded in the id', () => {
    const script = makeScript({ id: 'script_1723456789012_x9z', createdAt: 'not a date' })
    expect(getScriptTimestamp(script)).toBe(1723456789012)
  })

  it('falls back to parsing createdAt when the id has no timestamp', () => {
    const script = makeScript({ id: 'legacy-7', createdAt: '2024-08-23' })
    expect(getScriptTimestamp(script)).toBe(Date.parse('2024-08-23'))
  })

  it('returns zero when neither source is usable', () => {
    const script = makeScript({ id: 'legacy-7', createdAt: 'yesterday-ish' })
    expect(getScriptTimestamp(script)).toBe(0)
  })
})

describe('filterScriptsByQuery', () => {
  const scripts = [
    makeScript({ id: 'script_1_a', title: 'Deep Ocean Descent', initialPrompt: 'a slow beach induction' }),
    makeScript({ id: 'script_2_b', title: 'Forest Clearing', initialPrompt: 'woodland calm with birdsong' }),
    makeScript({ id: 'script_3_c', title: 'Evening Wind-Down', initialPrompt: undefined })
  ]

  it('matches against the title case-insensitively', () => {
    const result = filterScriptsByQuery(scripts, 'FOREST')
    expect(result.map(s => s.id)).toEqual(['script_2_b'])
  })

  it('matches against the initial prompt case-insensitively', () => {
    const result = filterScriptsByQuery(scripts, 'Beach')
    expect(result.map(s => s.id)).toEqual(['script_1_a'])
  })

  it('returns everything for a blank or whitespace-only query', () => {
    expect(filterScriptsByQuery(scripts, '')).toEqual(scripts)
    expect(filterScriptsByQuery(scripts, '   ')).toEqual(scripts)
  })

  it('handles scripts with no initial prompt', () => {
    const result = filterScriptsByQuery(scripts, 'wind-down')
    expect(result.map(s => s.id)).toEqual(['script_3_c'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterScriptsByQuery(scripts, 'volcano')).toEqual([])
  })
})

describe('duplicateScriptStatus', () => {
  it('duplicates an in-progress source as a draft, even with content', () => {
    expect(duplicateScriptStatus({ status: 'in-progress', content: 'streamed so far' })).toBe('draft')
    expect(duplicateScriptStatus({ status: 'in-progress', content: '' })).toBe('draft')
  })

  it('duplicates a complete source with content as complete', () => {
    expect(duplicateScriptStatus({ status: 'complete', content: 'full script' })).toBe('complete')
  })

  it('duplicates an empty source as a draft', () => {
    expect(duplicateScriptStatus({ status: 'draft', content: '' })).toBe('draft')
    expect(duplicateScriptStatus({ status: undefined, content: '   ' })).toBe('draft')
  })

  it('derives complete from content when the source has no status', () => {
    expect(duplicateScriptStatus({ status: undefined, content: 'imported text' })).toBe('complete')
  })
})

describe('sortScriptsByCreation', () => {
  const older = makeScript({ id: 'script_1000_old', title: 'Older' })
  const newer = makeScript({ id: 'script_2000_new', title: 'Newer' })
  const newest = makeScript({ id: 'script_3000_top', title: 'Newest' })

  it('sorts newest first by default order', () => {
    const result = sortScriptsByCreation([older, newest, newer], 'newest')
    expect(result.map(s => s.title)).toEqual(['Newest', 'Newer', 'Older'])
  })

  it('sorts oldest first when asked', () => {
    const result = sortScriptsByCreation([newer, older, newest], 'oldest')
    expect(result.map(s => s.title)).toEqual(['Older', 'Newer', 'Newest'])
  })

  it('does not mutate the input array', () => {
    const input = [newer, older]
    sortScriptsByCreation(input, 'newest')
    expect(input.map(s => s.title)).toEqual(['Newer', 'Older'])
  })

  it('keeps input order for equal timestamps', () => {
    const twinA = makeScript({ id: 'script_5000_a', title: 'Twin A' })
    const twinB = makeScript({ id: 'script_5000_b', title: 'Twin B' })
    const result = sortScriptsByCreation([twinA, twinB], 'newest')
    expect(result.map(s => s.title)).toEqual(['Twin A', 'Twin B'])
  })
})
