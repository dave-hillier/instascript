import { describe, it, expect } from 'vitest'
import {
  tokenize,
  rankExamples,
  rankExamplesByEmbedding,
  fuseRankings,
  selectDiverseExamples,
  type RankableExample,
  type RankedExample
} from '../exampleRanking'

const example = (
  id: string,
  title: string,
  tags: string[],
  content: string
): RankableExample => ({ id, title, tags, content })

describe('tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenize('Deep Sleep... and REST!')).toEqual(['deep', 'sleep', 'rest'])
  })

  it('drops stopwords and single characters', () => {
    expect(tokenize('you drift into a calm sea')).toEqual(['drift', 'calm', 'sea'])
  })
})

describe('rankExamples', () => {
  const corpus = [
    example('confidence', 'Confidence Building', ['confidence'],
      'You are naturally confident and capable. Your inner strength grows.'),
    example('sleep', 'Deep Relaxation for Sleep', ['sleep'],
      'Release all tension as you prepare for restful sleep. Deep restorative sleep comes easily.'),
    example('speaking', 'Public Speaking Confidence', ['confidence', 'speaking'],
      'Your natural ability to communicate clearly is awakening before an audience.')
  ]

  it('ranks the topically matching example first', () => {
    const ranked = rankExamples('help me fall into a deep sleep', corpus)
    expect(ranked[0].example.id).toBe('sleep')
    expect(ranked[0].score).toBeGreaterThan(0)
  })

  it('ranks by relevance, not corpus order', () => {
    const ranked = rankExamples('confidence speaking to an audience', corpus)
    expect(ranked[0].example.id).toBe('speaking')
    expect(ranked.map(entry => entry.example.id)).toContain('confidence')
  })

  it('weights title and tag matches above body mentions', () => {
    const corpusWithBodyMention = [
      example('body-only', 'Morning Energy', [],
        'A brief aside about sleep in passing, then energy and vitality all day.'),
      example('titled', 'Sleep Deeply Tonight', ['sleep'],
        'Rest comes gently as the evening settles around you.')
    ]
    const ranked = rankExamples('sleep', corpusWithBodyMention)
    expect(ranked[0].example.id).toBe('titled')
  })

  it('returns every example even when the query matches nothing', () => {
    const ranked = rankExamples('zzzz qqqq', corpus)
    expect(ranked).toHaveLength(corpus.length)
    expect(ranked.every(entry => entry.score === 0)).toBe(true)
  })

  it('returns an empty list for an empty corpus', () => {
    expect(rankExamples('sleep', [])).toEqual([])
  })
})

describe('selectDiverseExamples', () => {
  const duplicateBody =
    'Close your eyes and breathe slowly. Sink into deep restful sleep as waves of calm wash over your body and mind tonight.'

  const nearDuplicates = [
    example('dup-a', 'Deep Sleep A', ['sleep'], duplicateBody),
    example('dup-b', 'Deep Sleep B', ['sleep'], duplicateBody + ' Rest now.'),
    example('dup-c', 'Deep Sleep C', ['sleep'], duplicateBody + ' Drift away.'),
    example('distinct', 'Confidence at Work', ['confidence'],
      'Stand tall in meetings. Your voice carries authority and your ideas land with clarity and conviction at work.')
  ]

  it('does not select every near-duplicate; a different example wins a slot', () => {
    const ranked = rankExamples('deep restful sleep tonight', nearDuplicates)
    const selected = selectDiverseExamples(ranked, { limit: 3 })
    const ids = selected.map(entry => entry.example.id)

    const duplicatesChosen = ids.filter(id => id.startsWith('dup-')).length
    expect(duplicatesChosen).toBeLessThan(3)
    expect(ids).toContain('distinct')
  })

  it('keeps the most relevant example as the first pick', () => {
    const ranked = rankExamples('deep restful sleep tonight', nearDuplicates)
    const selected = selectDiverseExamples(ranked, { limit: 2 })
    expect(selected[0].example.id).toBe(ranked[0].example.id)
  })

  it('respects the token budget using actual example sizes', () => {
    const small = example('small', 'Small', [], 'calm rest '.repeat(20)) // ~50 tokens
    const large = example('large', 'Large', [], 'calm rest '.repeat(400)) // ~1000 tokens
    const ranked = rankExamples('calm rest', [large, small])

    const selected = selectDiverseExamples(ranked, { limit: 2, tokenBudget: 200 })
    expect(selected.map(entry => entry.example.id)).toEqual(['small'])
  })

  it('stops at the requested limit', () => {
    const ranked = rankExamples('sleep', nearDuplicates)
    expect(selectDiverseExamples(ranked, { limit: 2 })).toHaveLength(2)
  })

  it('returns nothing for a zero limit', () => {
    const ranked = rankExamples('sleep', nearDuplicates)
    expect(selectDiverseExamples(ranked, { limit: 0 })).toEqual([])
  })
})

describe('rankExamplesByEmbedding', () => {
  const embedded = (id: string, embedding?: number[]): RankableExample => ({
    id,
    title: id,
    tags: [],
    content: 'body text',
    embedding
  })

  it('ranks by cosine similarity to the query embedding', () => {
    const corpus = [
      embedded('orthogonal', [0, 1, 0]),
      embedded('aligned', [1, 0, 0]),
      embedded('opposed', [-1, 0, 0])
    ]
    const ranked = rankExamplesByEmbedding([1, 0, 0], corpus)
    expect(ranked.map(entry => entry.example.id)).toEqual([
      'aligned', 'orthogonal', 'opposed'
    ])
    expect(ranked[0].score).toBeCloseTo(1)
    expect(ranked[2].score).toBeCloseTo(-1)
  })

  it('omits examples without a stored embedding', () => {
    const corpus = [
      embedded('no-embedding'),
      embedded('empty-embedding', []),
      embedded('has-embedding', [1, 0])
    ]
    const ranked = rankExamplesByEmbedding([1, 0], corpus)
    expect(ranked.map(entry => entry.example.id)).toEqual(['has-embedding'])
  })

  it('scores mismatched vector lengths as zero rather than crashing', () => {
    const ranked = rankExamplesByEmbedding([1, 0, 0], [embedded('short', [1, 0])])
    expect(ranked[0].score).toBe(0)
  })
})

describe('fuseRankings', () => {
  const plain = (id: string): RankableExample => ({
    id,
    title: id,
    tags: [],
    content: 'body'
  })
  const ranking = (...ids: string[]): RankedExample<RankableExample>[] =>
    ids.map((id, index) => ({ example: plain(id), score: 10 - index }))

  it('promotes documents that both signals agree on', () => {
    const fused = fuseRankings([ranking('a', 'b', 'c'), ranking('b', 'c', 'd')])
    // b places high in both lists (ranks 2 and 1), beating a — which leads
    // one list but misses the other; d, low in a single list, lands last
    expect(fused[0].example.id).toBe('b')
    expect(fused[fused.length - 1].example.id).toBe('d')
  })

  it('still scores documents present in only one list', () => {
    const fused = fuseRankings([ranking('a', 'b'), ranking('c')])
    const ids = fused.map(entry => entry.example.id)
    expect(ids).toContain('c')
    expect(fused.find(entry => entry.example.id === 'c')!.score).toBeGreaterThan(0)
  })

  it('preserves order when only one signal is available (BM25 degradation)', () => {
    const lexicalOnly = ranking('sleep', 'calm', 'focus')
    const fused = fuseRankings([lexicalOnly])
    expect(fused.map(entry => entry.example.id)).toEqual(['sleep', 'calm', 'focus'])
    expect(fused.every(entry => entry.score > 0)).toBe(true)
  })

  it('returns an empty ranking for no input lists', () => {
    expect(fuseRankings([])).toEqual([])
  })
})
