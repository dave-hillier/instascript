import type { ExampleScript } from './vectorStore'

export interface ExampleSearchService {
  searchExamples(query: string, limit?: number): Promise<ExampleScript[]>
}
