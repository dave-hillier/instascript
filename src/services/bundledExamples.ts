import type { ExampleScript, ExampleSearchService } from './exampleSearchService'
import { getAllExamples } from './exampleCorpus'
import {
  fuseRankings,
  rankExamples,
  rankExamplesByEmbedding,
  selectDiverseExamples,
  type RankedExample
} from './exampleRanking'
import type { ExampleRecord } from '../types/example'
import { CONTEXT_LIMITS } from '../utils/contextWindow'

// Local hybrid example retrieval: bundled corpus merged with user-imported
// examples, ranked lexically (BM25) and densely (stored sentence embeddings
// vs the embedded brief), fused via reciprocal rank fusion, then selected
// for diversity under the context token budget. Runs entirely in the
// browser — no API key, works identically for every provider. When the
// embedding model is unavailable or no example carries an embedding,
// ranking degrades to pure BM25.
export class BundledExampleService implements ExampleSearchService {
  // The corpus loader is injectable so tests can rank a fake corpus without
  // touching localStorage or the bundled data
  private readonly loadExamples: () => ExampleRecord[]

  constructor(loadExamples: () => ExampleRecord[] = getAllExamples) {
    this.loadExamples = loadExamples
  }

  async searchExamples(query: string, limit?: number): Promise<ExampleScript[]> {
    const count = limit ?? CONTEXT_LIMITS.DEFAULT_EXAMPLES
    const examples = this.loadExamples()

    const lexical = rankExamples(query, examples)
    const dense = await this.rankDense(query, examples)
    const ranked = fuseRankings(dense.length > 0 ? [lexical, dense] : [lexical])

    const selected = selectDiverseExamples(ranked, {
      limit: count,
      tokenBudget: count * CONTEXT_LIMITS.AVERAGE_EXAMPLE_TOKENS
    })

    return selected.map(({ example, score }) => ({
      content: example.content,
      score,
      metadata: {
        id: example.id,
        title: example.title,
        source: example.source,
        tags: example.tags.join(', ')
      }
    }))
  }

  // Only the brief is embedded at generation time; corpus embeddings were
  // stored at import/promotion time. Any failure yields an empty dense list.
  private async rankDense(
    query: string,
    examples: ExampleRecord[]
  ): Promise<RankedExample<ExampleRecord>[]> {
    if (!examples.some(example => example.embedding && example.embedding.length > 0)) {
      return []
    }
    try {
      const { embedText } = await import('./embeddingService')
      const queryEmbedding = await embedText(query)
      if (!queryEmbedding) return []
      return rankExamplesByEmbedding(queryEmbedding, examples)
    } catch (error) {
      console.warn('Dense ranking unavailable, using lexical only:', error)
      return []
    }
  }
}
