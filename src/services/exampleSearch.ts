import type { ExampleScript } from './vectorStore'
import type { AppConfig } from './config'
import { VectorStoreService } from './vectorStore'
import { MockVectorStoreService } from './mockVectorStore'
import { canUseOpenAI } from './config'
import { getRecommendedExampleCount } from '../utils/contextWindow'

export async function searchExamples(
  config: AppConfig,
  query: string,
  limit?: number
): Promise<ExampleScript[]> {
  
  let service
  if (canUseOpenAI(config)) {
    service = new VectorStoreService(config.apiKey!)
  } else {
    service = new MockVectorStoreService()
  }

  const actualLimit = limit || getRecommendedExampleCount()
  return service.searchExamples(query, actualLimit)
}

