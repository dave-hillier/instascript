// Client-side sentence embeddings for hybrid example retrieval. The model
// (a small quantized MiniLM) is loaded lazily via dynamic import so none of
// the transformers.js code lands in the main bundle, and everything runs in
// the browser — no backend, no API key.
//
// Every entry point degrades gracefully: if the model fails to load or a
// single embedding fails, callers get null and fall back to lexical ranking.

export type Embedder = (text: string) => Promise<number[]>
export type EmbedderLoader = () => Promise<Embedder>

export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

let embedderPromise: Promise<Embedder | null> | null = null
let loaderOverride: EmbedderLoader | null = null

// Test seam: inject a fake embedder loader so tests never touch the network.
// Passing null restores the real lazy loader.
export function setEmbedderLoaderForTesting(loader: EmbedderLoader | null): void {
  loaderOverride = loader
  embedderPromise = null
}

async function loadTransformersEmbedder(): Promise<Embedder> {
  const { pipeline } = await import('@huggingface/transformers')
  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: 'q8'
  })
  return async (text: string) => {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data as Float32Array)
  }
}

function getEmbedder(): Promise<Embedder | null> {
  if (!embedderPromise) {
    const load = loaderOverride ?? loadTransformersEmbedder
    embedderPromise = load().catch(error => {
      console.warn('Embedding model unavailable, falling back to lexical ranking:', error)
      return null
    })
  }
  return embedderPromise
}

// Embeds a piece of text, or returns null when the model is unavailable or
// the embedding fails — callers must treat null as "no dense signal".
export async function embedText(text: string): Promise<number[] | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  try {
    return await embedder(text)
  } catch (error) {
    console.warn('Embedding failed:', error)
    return null
  }
}

// The text an example is embedded under: title and tags carry the mood and
// topic, the body carries the style. The model truncates long inputs itself.
export function embeddingInputForExample(example: {
  title: string
  tags: string[]
  content: string
}): string {
  return [example.title, example.tags.join(', '), example.content]
    .filter(Boolean)
    .join('\n')
}
