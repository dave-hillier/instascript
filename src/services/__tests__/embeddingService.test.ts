import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  embedText,
  embeddingInputForExample,
  setEmbedderLoaderForTesting
} from '../embeddingService'

// The real loader dynamically imports transformers.js and downloads a model;
// these tests always inject a fake loader so nothing touches the network.

afterEach(() => {
  setEmbedderLoaderForTesting(null)
  vi.restoreAllMocks()
})

describe('embedText', () => {
  it('returns the vector produced by the loaded embedder', async () => {
    setEmbedderLoaderForTesting(async () => async () => [0.1, 0.2, 0.3])
    expect(await embedText('slow, heavy, sinking')).toEqual([0.1, 0.2, 0.3])
  })

  it('loads the embedder once and reuses it across calls', async () => {
    const loader = vi.fn(async () => async (text: string) => [text.length])
    setEmbedderLoaderForTesting(loader)

    expect(await embedText('ab')).toEqual([2])
    expect(await embedText('abcd')).toEqual([4])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns null when the model fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setEmbedderLoaderForTesting(async () => {
      throw new Error('download failed')
    })
    expect(await embedText('anything')).toBeNull()
  })

  it('keeps returning null after a load failure without retry storms', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = vi.fn(async (): Promise<never> => {
      throw new Error('no network')
    })
    setEmbedderLoaderForTesting(loader)

    expect(await embedText('first')).toBeNull()
    expect(await embedText('second')).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns null when a single embedding call throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setEmbedderLoaderForTesting(async () => async () => {
      throw new Error('inference error')
    })
    expect(await embedText('anything')).toBeNull()
  })
})

describe('embeddingInputForExample', () => {
  it('joins title, tags and content, skipping empty parts', () => {
    expect(
      embeddingInputForExample({
        title: 'Evening Calm',
        tags: ['sleep', 'calm'],
        content: 'Breathe out slowly.'
      })
    ).toBe('Evening Calm\nsleep, calm\nBreathe out slowly.')

    expect(
      embeddingInputForExample({ title: 'Untagged', tags: [], content: 'Body.' })
    ).toBe('Untagged\nBody.')
  })
})
