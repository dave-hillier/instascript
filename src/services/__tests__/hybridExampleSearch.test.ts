import { describe, it, expect, afterEach, vi } from 'vitest'
import { BundledExampleService } from '../bundledExamples'
import { setEmbedderLoaderForTesting } from '../embeddingService'
import { formatExamplesForPrompt } from '../prompts'
import type { ExampleRecord } from '../../types/example'

// End-to-end retrieval through BundledExampleService with a fake corpus and
// a fake embedder — no localStorage, no bundled data, no model download.

const record = (
  id: string,
  title: string,
  content: string,
  embedding?: number[]
): ExampleRecord => ({
  id,
  title,
  tags: [],
  group: 'Test group',
  content,
  source: 'user',
  embedding
})

afterEach(() => {
  setEmbedderLoaderForTesting(null)
  vi.restoreAllMocks()
})

describe('BundledExampleService hybrid retrieval', () => {
  it('lets the dense signal surface a stylistic match sharing no vocabulary', async () => {
    // "sinking" brief: lexically it matches only the decoy title; the
    // embedding signal points at the stylistic match instead
    const corpus = [
      record('lexical-decoy', 'Sinking Ships of History', 'Naval battles and maritime disasters.', [0, 1]),
      record('stylistic-match', 'Weighted Rest', 'Your limbs grow weighted, drawn downward into stillness.', [1, 0]),
      record('unrelated', 'Morning Energy', 'Bright awakening and vitality.', [0, -1])
    ]
    setEmbedderLoaderForTesting(async () => async () => [1, 0])

    const service = new BundledExampleService(() => corpus)
    const results = await service.searchExamples('slow, heavy, sinking', 2)

    expect(results.map(result => result.metadata?.id)).toContain('stylistic-match')
  })

  it('degrades to pure BM25 when the embedding model fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const corpus = [
      record('sleep', 'Deep Sleep', 'Restful deep sleep comes easily tonight.', [1, 0]),
      record('focus', 'Sharp Focus', 'Concentration sharpens with every breath.', [0, 1])
    ]
    setEmbedderLoaderForTesting(async () => {
      throw new Error('model download failed')
    })

    const service = new BundledExampleService(() => corpus)
    const results = await service.searchExamples('deep sleep', 1)

    expect(results).toHaveLength(1)
    expect(results[0].metadata?.id).toBe('sleep')
  })

  it('works on a corpus with no embeddings at all without loading the model', async () => {
    const loader = vi.fn(async () => async () => [1, 0])
    setEmbedderLoaderForTesting(loader)
    const corpus = [
      record('sleep', 'Deep Sleep', 'Restful deep sleep comes easily tonight.'),
      record('focus', 'Sharp Focus', 'Concentration sharpens with every breath.')
    ]

    const service = new BundledExampleService(() => corpus)
    const results = await service.searchExamples('deep sleep', 1)

    expect(results[0].metadata?.id).toBe('sleep')
    expect(loader).not.toHaveBeenCalled()
  })

  it('names every retrieved example in the formatted prompt block', async () => {
    const corpus = [
      record('sleep', 'Deep Sleep', 'Restful deep sleep comes easily tonight.'),
      record('focus', 'Sharp Focus', 'Concentration sharpens with every breath.')
    ]

    const service = new BundledExampleService(() => corpus)
    const formatted = formatExamplesForPrompt(await service.searchExamples('deep sleep', 2))

    expect(formatted).toContain('Deep Sleep')
    expect(formatted).toContain('Sharp Focus')
    expect(formatted).not.toContain('Unknown')
  })

  it('still ranks examples missing embeddings via the lexical list', async () => {
    setEmbedderLoaderForTesting(async () => async () => [1, 0])
    const corpus = [
      record('embedded', 'Calm Drift', 'Drifting gently into calm.', [1, 0]),
      record('not-embedded', 'Deep Sleep', 'Restful deep sleep comes easily tonight.')
    ]

    const service = new BundledExampleService(() => corpus)
    const results = await service.searchExamples('deep sleep', 2)

    expect(results.map(result => result.metadata?.id)).toContain('not-embedded')
  })
})
