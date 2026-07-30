// Story 5.7: the small-model jobs that run over a freshly imported example —
// suggesting tags for an untagged import, and formatting a plain-text import
// as markdown. Both are handed to the utility model rather than the
// generation model: they are mechanical, they benefit from being fast, and
// they should not cost script-writing money.
//
// The parsing and the safety checks here are pure, so a small model's
// approximate obedience is corrected in code rather than trusted.

import type { ExampleRecord } from '../types/example'
import type { UtilityModelService } from './utilityModelService'
import {
  buildExampleTaggingPrompt,
  buildImportFormattingPrompt,
  buildTaggingInput
} from './prompts'

export const MAX_SUGGESTED_TAGS = 6

// Tags are short labels; anything longer is the model explaining itself
const MAX_TAG_LENGTH = 40
const MAX_TAG_WORDS = 4

// A short snippet has no structure worth adding headings to, and a stray
// note imported alongside real scripts should not cost a request
const MIN_FORMATTING_LENGTH = 400

// A formatting pass rearranges whitespace and adds headings; it must not lose
// or invent prose. Anything outside this band of retained words is a model
// that summarised or embellished, and the original is kept instead.
const MIN_RETAINED_WORD_RATIO = 0.9
const MAX_RETAINED_WORD_RATIO = 1.1

const HEADING_LINE = /^\s{0,3}#{1,6}\s+\S/

// Pure: the tags from a model reply. Accepts the comma-separated single line
// the prompt asks for, and tolerates the bulleted list, numbered list or
// "Tags: ..." preamble a smaller model sometimes returns instead.
export function parseSuggestedTags(text: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()

  for (const rawToken of text.split(/[,\n]/)) {
    // Drops list markers and any "Here are the tags:" style prefix
    const token = rawToken
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .split(':')
      .pop() ?? ''
    const tag = token
      .replace(/["'`]/g, '')
      .replace(/[.;]+$/, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')

    if (!tag || tag.length > MAX_TAG_LENGTH) continue
    if (!/[a-z]/.test(tag)) continue
    if (tag.split(' ').length > MAX_TAG_WORDS) continue
    if (seen.has(tag)) continue

    seen.add(tag)
    tags.push(tag)
    if (tags.length === MAX_SUGGESTED_TAGS) break
  }

  return tags
}

// Pure: whether an import would gain from a markdown pass. Anything that
// already carries headings is left exactly as the user wrote it.
export function needsMarkdownFormatting(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length < MIN_FORMATTING_LENGTH) return false
  return !HEADING_LINE.test(trimmed)
}

// Pure: the markdown from a model reply, with the code fence some models wrap
// it in removed
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/)
  return (fenced ? fenced[1] : trimmed).trim()
}

// The prose of a script, ignoring heading lines, as a word count. Headings
// are the one thing formatting is allowed to add.
function bodyWordCount(text: string): number {
  return text
    .split('\n')
    .filter(line => !HEADING_LINE.test(line))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length
}

// Pure: whether a formatting result may replace the original. It must have
// gained structure and kept the script's words — a model that summarised the
// script, or wrote commentary around it, fails here and is discarded.
export function isFaithfulFormatting(original: string, formatted: string): boolean {
  if (!formatted.trim()) return false
  if (!HEADING_LINE.test(formatted)) return false

  const originalWords = bodyWordCount(original)
  if (originalWords === 0) return false

  const ratio = bodyWordCount(formatted) / originalWords
  return ratio >= MIN_RETAINED_WORD_RATIO && ratio <= MAX_RETAINED_WORD_RATIO
}

export interface ImportEnhancement {
  tags?: string[]
  content?: string
}

// Runs the utility jobs an imported example needs. Each job is independent:
// a failure or an unusable reply leaves that part of the example as imported
// rather than failing the import.
export async function enhanceImportedExample(
  example: ExampleRecord,
  service: UtilityModelService,
  knownTags: string[],
  signal?: AbortSignal
): Promise<ImportEnhancement> {
  const enhancement: ImportEnhancement = {}
  let content = example.content

  if (needsMarkdownFormatting(content)) {
    try {
      const reply = await service.complete({
        job: 'formatting',
        system: buildImportFormattingPrompt(example.title),
        user: content,
        signal
      })
      const formatted = stripCodeFence(reply)
      if (isFaithfulFormatting(content, formatted)) {
        enhancement.content = formatted
        content = formatted
      }
    } catch (error) {
      console.warn(`Could not format imported example "${example.title}" as markdown:`, error)
    }
  }

  if (example.tags.length === 0) {
    try {
      const reply = await service.complete({
        job: 'tagging',
        system: buildExampleTaggingPrompt(knownTags),
        user: buildTaggingInput(example.title, content),
        signal
      })
      const tags = parseSuggestedTags(reply)
      if (tags.length > 0) enhancement.tags = tags
    } catch (error) {
      console.warn(`Could not suggest tags for imported example "${example.title}":`, error)
    }
  }

  return enhancement
}

export interface ImportAssistOutcome {
  tagged: number
  formatted: number
}

// Pure: the status line for what the utility model did to this import
export function describeImportAssist(
  { tagged, formatted }: ImportAssistOutcome,
  model: string
): string {
  if (tagged === 0 && formatted === 0) return ''
  const parts: string[] = []
  if (tagged > 0) parts.push(`tagged ${tagged}`)
  if (formatted > 0) parts.push(`formatted ${formatted} as markdown`)
  return `${model} ${parts.join(' and ')}.`
}
