import type { ExampleScript, ExampleSearchService } from './exampleSearchService'
import { getAllExamples } from './exampleCorpus'
import { rankExamples, selectDiverseExamples } from './exampleRanking'
import { CONTEXT_LIMITS } from '../utils/contextWindow'

// Local example retrieval: bundled corpus merged with user-imported examples,
// ranked lexically (BM25) against the brief, then selected for diversity
// under the context token budget. Runs entirely in the browser — no API key,
// works identically for every provider.
export class BundledExampleService implements ExampleSearchService {
  async searchExamples(query: string, limit?: number): Promise<ExampleScript[]> {
    const count = limit ?? CONTEXT_LIMITS.DEFAULT_EXAMPLES
    const ranked = rankExamples(query, getAllExamples())
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
}
