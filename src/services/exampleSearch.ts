import type { ExampleScript } from './exampleSearchService'
import { BundledExampleService } from './bundledExamples'
import { getRecommendedExampleCount } from '../utils/contextWindow'

export async function searchExamples(
  query: string,
  limit?: number
): Promise<ExampleScript[]> {
  const service = new BundledExampleService()
  const actualLimit = limit || getRecommendedExampleCount()
  return service.searchExamples(query, actualLimit)
}
