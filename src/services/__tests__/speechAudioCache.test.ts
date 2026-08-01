import { describe, expect, it } from 'vitest'
import { selectEvictions, speechCacheKey, type CachedUtteranceUsage } from '../speechAudioCache'

const entry = (key: string, usedAt: number, bytes: number): CachedUtteranceUsage => ({
  key,
  usedAt,
  bytes,
})

describe('selectEvictions', () => {
  it('keeps everything while the cache fits its budget', () => {
    expect(selectEvictions([entry('a', 1, 400), entry('b', 2, 400)], 1000)).toEqual([])
  })

  it('discards the least recently used first', () => {
    const evicted = selectEvictions(
      [entry('new', 300, 600), entry('old', 100, 600), entry('middle', 200, 600)],
      1300
    )
    expect(evicted).toEqual(['old'])
  })

  it('discards only as much as the overshoot needs', () => {
    const evicted = selectEvictions(
      [entry('a', 1, 500), entry('b', 2, 500), entry('c', 3, 500), entry('d', 4, 500)],
      1000
    )
    expect(evicted).toEqual(['a', 'b'])
  })

  it('measures the overshoot in bytes, not in entries', () => {
    // One large recent entry outweighs several small old ones; the budget is
    // met by dropping the oldest until the bytes fit, whatever the count.
    const evicted = selectEvictions(
      [entry('huge', 9, 900), entry('tiny-old', 1, 50), entry('tiny-older', 0, 50)],
      950
    )
    expect(evicted).toEqual(['tiny-older'])
  })

  it('is a recency order, not an insertion order', () => {
    // 'replayed' was written first but heard most recently, so it stays.
    const evicted = selectEvictions(
      [entry('replayed', 500, 600), entry('written-later', 200, 600)],
      1000
    )
    expect(evicted).toEqual(['written-later'])
  })

  it('empties the cache when nothing fits', () => {
    expect(selectEvictions([entry('a', 1, 400), entry('b', 2, 400)], 0)).toEqual(['a', 'b'])
  })

  it('has nothing to discard from an empty cache', () => {
    expect(selectEvictions([], 1000)).toEqual([])
  })
})

describe('speechCacheKey', () => {
  it('separates the same line spoken by different voices', () => {
    expect(speechCacheKey('m', 'Eve', 'Breathe.')).not.toBe(speechCacheKey('m', 'Rex', 'Breathe.'))
  })

  it('repeats for an unchanged utterance, so a replay costs nothing', () => {
    expect(speechCacheKey('m', 'Eve', 'Breathe.')).toBe(speechCacheKey('m', 'Eve', 'Breathe.'))
  })
})
