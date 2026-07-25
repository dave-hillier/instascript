import hypnosisSystemPrompt from '../prompts/hypnosis-system.txt?raw'
import sectionRegenerationPrompt from '../prompts/section-regeneration.txt?raw'
import outlineGenerationPrompt from '../prompts/outline-generation.txt?raw'
import sectionGenerationPrompt from '../prompts/section-generation.txt?raw'
import scriptRefinementPrompt from '../prompts/script-refinement.txt?raw'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversation } from '../types/conversation'
import { getLatestOutline, consolidateSections } from './conversationDocument'
import type { DocumentSection } from './conversationDocument'

/**
 * Pure functions for prompt generation
 */

const CONTINUITY_EXCERPT_WORDS = 75

export function getSystemPrompt(): string {
  return hypnosisSystemPrompt
}

export function getOutlineGenerationPrompt(): string {
  return outlineGenerationPrompt
}

export function getSectionGenerationPrompt(sectionTitle: string, sectionDescription: string): string {
  return sectionGenerationPrompt
    .replace('{sectionTitle}', sectionTitle)
    .replace('{sectionDescription}', sectionDescription)
}

function excerptStart(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(word => word.length > 0)
  if (words.length <= maxWords) return text.trim()
  return words.slice(0, maxWords).join(' ') + ' …'
}

function excerptEnd(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(word => word.length > 0)
  if (words.length <= maxWords) return text.trim()
  return '… ' + words.slice(-maxWords).join(' ')
}

export interface SectionRegenerationContext {
  sectionTitle: string
  outlineDescription?: string
  previousSection?: DocumentSection
  nextSection?: DocumentSection
  instruction?: string
}

// Outline-aware section regeneration: the section's outline entry supplies
// the spec, the surrounding sections supply continuity, and an optional
// user instruction directs the rewrite.
export function buildSectionRegenerationPrompt(context: SectionRegenerationContext): string {
  const description = context.outlineDescription?.trim()
    ? context.outlineDescription.trim()
    : 'consistent with its current role and position in the script'

  const continuityParts: string[] = []
  if (context.previousSection) {
    continuityParts.push(
      `The preceding section "${context.previousSection.title}" currently ends with:\n\n` +
      excerptEnd(context.previousSection.content, CONTINUITY_EXCERPT_WORDS)
    )
  }
  if (context.nextSection) {
    continuityParts.push(
      `The following section "${context.nextSection.title}" currently begins with:\n\n` +
      excerptStart(context.nextSection.content, CONTINUITY_EXCERPT_WORDS)
    )
  }
  const continuity = continuityParts.length > 0
    ? '\n' + continuityParts.join('\n\n') + '\n'
    : ''

  let prompt = sectionRegenerationPrompt
    .replace(/\{sectionTitle\}/g, context.sectionTitle)
    .replace('{sectionDescription}', description)
    .replace('{continuity}', continuity)

  const instruction = context.instruction?.trim()
  if (instruction) {
    prompt += `\n\nAdditional instruction from the user for this rewrite:\n${instruction}`
  }

  return prompt
}

export function buildSectionRegenerationPromptFromConversation(
  conversation: RawConversation,
  sectionTitle: string,
  instruction?: string
): string {
  const outline = getLatestOutline(conversation)
  const sections = consolidateSections(conversation)
  const index = sections.findIndex(section => section.title === sectionTitle)

  return buildSectionRegenerationPrompt({
    sectionTitle,
    outlineDescription: outline?.sections.find(section => section.title === sectionTitle)?.description,
    previousSection: index > 0 ? sections[index - 1] : undefined,
    nextSection: index >= 0 && index < sections.length - 1 ? sections[index + 1] : undefined,
    instruction
  })
}

export function getScriptRefinementPrompt(instruction: string): string {
  return scriptRefinementPrompt.replace('{instruction}', instruction.trim())
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
