import type { ExampleScript } from './vectorStore'

export interface ExampleSearchService {
  searchExamples(query: string, limit?: number): Promise<ExampleScript[]>
}

export function formatExamplesForPrompt(examples: ExampleScript[]): string {
  if (examples.length === 0) return '\n## Examples\n\nNo relevant examples found.\n'
  
  return '\n## Examples\n\n' + 
    examples.map((example, index) => 
      `### Example ${index + 1}: ${example.metadata?.filename || 'Unknown'}\n\n${example.content}`
    ).join('\n\n') + '\n'
}