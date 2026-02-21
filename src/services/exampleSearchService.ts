export interface ExampleScript {
  content: string
  metadata?: Record<string, string | number>
  score?: number
}

export interface ExampleSearchService {
  searchExamples(query: string, limit?: number): Promise<ExampleScript[]>
}
