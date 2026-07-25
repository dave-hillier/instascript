import hypnosisSystemPrompt from '../prompts/hypnosis-system.txt?raw'
import sectionRegenerationPrompt from '../prompts/section-regeneration.txt?raw'
import outlineGenerationPrompt from '../prompts/outline-generation.txt?raw'
import sectionGenerationPrompt from '../prompts/section-generation.txt?raw'
import scriptRefinementPrompt from '../prompts/script-refinement.txt?raw'
import styleCritiquePrompt from '../prompts/style-critique.txt?raw'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversation, ChatMessage } from '../types/conversation'
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

// The numbered style rules as written in hypnosis-system.txt — the single
// source of truth shared by generation and the style-review pass (story 8.5)
export function getStyleRules(): string {
  const index = hypnosisSystemPrompt.indexOf('## Style rules')
  return (index >= 0 ? hypnosisSystemPrompt.slice(index) : hypnosisSystemPrompt).trim()
}

// The critique request for the style-review pass: the consolidated script
// plus the system prompt's own style rules, asking for one strict
// line-oriented verdict per section
export function buildStyleCritiquePrompt(script: string): string {
  return styleCritiquePrompt
    .replace('{styleRules}', getStyleRules())
    .replace('{script}', script)
}

export function getScriptRefinementPrompt(instruction: string): string {
  return scriptRefinementPrompt.replace('{instruction}', instruction.trim())
}

// Deliberate exemplar ordering (story 8.8): search returns examples ranked
// most-relevant-first, but few-shot output quality is swayed most by the
// exemplar closest to the instruction — so the prompt places the MOST
// relevant example LAST. This is the single place that ordering rule lives.
export function orderExamplesForPrompt(examples: ExampleScript[]): ExampleScript[] {
  return [...examples].reverse()
}

export function formatExamplesForPrompt(examples: ExampleScript[]): string {
  if (examples.length === 0) {
    console.warn('No examples to format for prompt')
    return '\n\n'
  }

  return '\n## Examples\n\n' +
    orderExamplesForPrompt(examples).map((example, index) =>
      `### Example ${index + 1}: ${example.metadata?.filename || 'Unknown'}\n\n${example.content}`
    ).join('\n\n') + '\n'
}

// Conversation-history normalisation (story 8.13): generations store the
// complete messages array each request was sent with, so flattening them for
// a follow-up request can accumulate system messages. Providers behave
// unpredictably with more than one, so prompt assembly enforces the
// invariant: exactly one system message, first, with any later system turn
// that carries different instructions expressed as a user turn instead
// (identical repeats are dropped).
export function normaliseConversationHistory(messages: ChatMessage[]): ChatMessage[] {
  const firstSystem = messages.find(message => message.role === 'system')
  if (!firstSystem) return [...messages]

  const normalised: ChatMessage[] = [firstSystem]
  for (const message of messages) {
    if (message.role !== 'system') {
      normalised.push(message)
    } else if (message !== firstSystem && message.content !== firstSystem.content) {
      normalised.push({ role: 'user', content: message.content })
    }
  }
  return normalised
}

// Flattens every generation's request messages and response into the history
// for a follow-up request (refinement or section regeneration), appending the
// new instruction as a user turn and normalising to a single system message.
export function buildConversationHistory(
  conversation: RawConversation,
  instruction: string
): ChatMessage[] {
  const flattened: ChatMessage[] = []

  for (const generation of conversation.generations) {
    flattened.push(...generation.messages)
    if (generation.response) {
      flattened.push({ role: 'assistant', content: generation.response })
    }
  }

  flattened.push({ role: 'user', content: instruction })

  return normaliseConversationHistory(flattened)
}
