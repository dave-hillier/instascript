import hypnosisSystemPrompt from '../prompts/hypnosis-system.txt?raw'
import sectionRegenerationPrompt from '../prompts/section-regeneration.txt?raw'
import type { ExampleScript } from './exampleSearchService'

/**
 * Pure functions for prompt generation
 */

export function getSystemPrompt(): string {
  return hypnosisSystemPrompt
}

export function getSectionRegenerationPrompt(sectionTitle: string): string {
  return sectionRegenerationPrompt.replace('{sectionTitle}', sectionTitle)
}

export function formatExamplesForPrompt(examples: ExampleScript[]): string {
  if (examples.length === 0) {
    console.warn('No examples to format for prompt')
    return '\n\n'
  }
  
  return '\n## Examples\n\n' + 
    examples.map((example, index) => 
      `### Example ${index + 1}: ${example.metadata?.filename || 'Unknown'}\n\n${example.content}`
    ).join('\n\n') + '\n'
}