// Story 5.7: the small-model jobs that run over a freshly imported example —
// suggesting tags for an untagged import, formatting a plain-text import as
// markdown, and (story 8.16, on request) rewriting a script that talks about
// a third person, or addresses a title, so that it speaks to the listener.
// All three are handed to the utility model rather than the generation model:
// they are mechanical, they benefit from being fast, and they should not cost
// script-writing money.
//
// The parsing and the safety checks here are pure, so a small model's
// approximate obedience is corrected in code rather than trusted.

import type { ExampleRecord } from '../types/example'
import type { UtilityModelService } from './utilityModelService'
import {
  buildDirectAddressPrompt,
  buildExampleTaggingPrompt,
  buildImportFormattingPrompt,
  buildTaggingInput
} from './prompts'
import { canonicalizeTags } from './standardTags'

// Room for the standard labels a script carries (story 8.17) plus the two to
// four topic tags the prompt asks for on top of them
export const MAX_SUGGESTED_TAGS = 9

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
// "Tags: ..." preamble a smaller model sometimes returns instead. A standard
// label the model wrote its own way ("nsfw", "for her") is collapsed onto the
// standard tag, and the standard ones lead — the cap should never fall on a
// label the vocabulary asked for while a loose topic tag survives.
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
    // Read a little past the cap before applying it: synonyms collapse onto
    // one another, so the tags worth keeping are only known after
    // canonicalisation
    if (tags.length === MAX_SUGGESTED_TAGS * 3) break
  }

  return canonicalizeTags(tags).slice(0, MAX_SUGGESTED_TAGS)
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

// Pure: the prose of a script, ignoring heading lines, as a word count.
// Headings are the one thing formatting is allowed to add — and the one thing
// the clean-up pass's sectioning (story 8.19) adds too, so both passes measure
// what they must not lose the same way.
export function bodyWordCount(text: string): number {
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

// --- Direct address (story 8.16) -----------------------------------------
// Material written for someone else — a script that narrates what "she"
// feels, or that has the listener drop "for Mistress" — grounds generation in
// a voice the user is not writing in. This pass puts it in the second person
// and takes the titles of address out, leaving everything else alone.

// Third-person narration. "they/them/their" are left out on purpose: a script
// written in the second person uses them constantly ("let them go").
const THIRD_PERSON = /\b(he|him|his|she|her|hers|himself|herself|the subject|the listener|the client)\b/gi

// Titles of address, for the guide and for the listener alike
const ADDRESS_TITLES = /\b(mistress|master|sir|ma'?am|madam|domme|goddess|daddy|mommy|owner|handler)\b/gi

// A rewrite changes person and drops titles; it does not shorten or pad the
// script. Anything outside this band is a model that summarised or embellished.
const MIN_VOICED_WORD_RATIO = 0.75
const MAX_VOICED_WORD_RATIO = 1.15

const ANY_HEADING = /^\s{0,3}(#{1,6})\s+\S/

// Pure: how much of the script is written about someone else, or spoken to a
// title. Used both to decide whether the pass is worth a request and to check
// afterwards that it actually did something.
export function countAddressMarkers(content: string): number {
  return (
    (content.match(THIRD_PERSON)?.length ?? 0) +
    (content.match(ADDRESS_TITLES)?.length ?? 0)
  )
}

// Pure: whether an import would gain from the pass at all
export function needsDirectAddress(content: string): boolean {
  return countAddressMarkers(content) > 0
}

// Pure: the heading levels of a document, in order. The pass may reword a
// heading that names a title of address, but it must not add, drop or
// restructure headings.
function headingShape(text: string): string {
  return text
    .split('\n')
    .map(line => line.match(ANY_HEADING)?.[1] ?? '')
    .filter(Boolean)
    .join(',')
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

// Pure: whether a rewrite may replace the original. It has to have kept the
// script's shape and length, and it has to have actually reduced the third
// person and the titles — a model that returned the script unchanged, or
// wrote commentary around it, fails here and the import keeps what it had.
export function isFaithfulVoicing(original: string, voiced: string): boolean {
  if (!voiced.trim()) return false
  if (headingShape(voiced) !== headingShape(original)) return false

  const originalWords = wordCount(original)
  if (originalWords === 0) return false
  const ratio = wordCount(voiced) / originalWords
  if (ratio < MIN_VOICED_WORD_RATIO || ratio > MAX_VOICED_WORD_RATIO) return false

  return countAddressMarkers(voiced) < countAddressMarkers(original)
}

// A rewrite reproduces the whole script, so the reply needs room for it.
// Roughly two tokens a word, with headroom for a reasoning model's own
// budget, and a ceiling so a huge import cannot ask for an absurd completion.
const MIN_REWRITE_TOKENS = 4096
const MAX_REWRITE_TOKENS = 32_000

export function rewriteTokenBudget(content: string): number {
  return Math.min(
    MAX_REWRITE_TOKENS,
    Math.max(MIN_REWRITE_TOKENS, Math.round(wordCount(content) * 2.5))
  )
}

// Runs the pass over a script and returns the rewrite, or null when there was
// nothing to do, the model could not be reached, or its reply failed the
// checks above. Used by the import and by the same action on an example
// already in the corpus.
export async function rewriteForDirectAddress(
  content: string,
  service: UtilityModelService,
  signal?: AbortSignal
): Promise<string | null> {
  if (!needsDirectAddress(content)) return null
  try {
    const reply = await service.complete({
      job: 'voicing',
      system: buildDirectAddressPrompt(),
      user: content,
      maxOutputTokens: rewriteTokenBudget(content),
      signal
    })
    const voiced = stripCodeFence(reply)
    return isFaithfulVoicing(content, voiced) ? voiced : null
  } catch (error) {
    console.warn('Could not rewrite the script into direct address:', error)
    return null
  }
}

export interface ImportEnhancement {
  tags?: string[]
  content?: string
  // Which passes the content owes its state to, so the import can report what
  // was done rather than only that something was
  voiced?: boolean
  formatted?: boolean
}

export type ImportAssistJob = 'formatting' | 'tagging' | 'voicing'

export interface EnhanceImportOptions {
  signal?: AbortSignal
  // Called as each job starts, so the import meter can name the stage a file
  // is sitting in rather than showing an unexplained pause
  onJobStarted?: (job: ImportAssistJob) => void
  // Whether the import asked for the direct-address rewrite. Off unless
  // chosen: it is the one job that changes the script's words.
  voicing?: boolean
}

// Which jobs an example still needs, so an import can skip the ones with
// nothing to do without paying for a request to find out
export function importAssistJobsFor(
  example: ExampleRecord,
  { voicing = false }: { voicing?: boolean } = {}
): ImportAssistJob[] {
  const jobs: ImportAssistJob[] = []
  if (voicing && needsDirectAddress(example.content)) jobs.push('voicing')
  if (needsMarkdownFormatting(example.content)) jobs.push('formatting')
  if (example.tags.length === 0) jobs.push('tagging')
  return jobs
}

// Runs the utility jobs an imported example needs. Each job is independent:
// a failure or an unusable reply leaves that part of the example as imported
// rather than failing the import. The rewrite runs first, so the formatting
// pass lays out the text that will actually be stored.
export async function enhanceImportedExample(
  example: ExampleRecord,
  service: UtilityModelService,
  knownTags: string[],
  { signal, onJobStarted, voicing = false }: EnhanceImportOptions = {}
): Promise<ImportEnhancement> {
  const enhancement: ImportEnhancement = {}
  let content = example.content

  if (voicing && needsDirectAddress(content)) {
    onJobStarted?.('voicing')
    const voiced = await rewriteForDirectAddress(content, service, signal)
    if (voiced) {
      enhancement.content = voiced
      enhancement.voiced = true
      content = voiced
    }
  }

  if (needsMarkdownFormatting(content)) {
    onJobStarted?.('formatting')
    try {
      const reply = await service.complete({
        job: 'formatting',
        system: buildImportFormattingPrompt(example.title),
        user: content,
        maxOutputTokens: rewriteTokenBudget(content),
        signal
      })
      const formatted = stripCodeFence(reply)
      if (isFaithfulFormatting(content, formatted)) {
        enhancement.content = formatted
        enhancement.formatted = true
        content = formatted
      }
    } catch (error) {
      console.warn(`Could not format imported example "${example.title}" as markdown:`, error)
    }
  }

  if (example.tags.length === 0) {
    onJobStarted?.('tagging')
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
  voiced: number
}

// Pure: the status line for what the utility model did to this import
export function describeImportAssist(
  { tagged, formatted, voiced }: ImportAssistOutcome,
  model: string
): string {
  const parts: string[] = []
  if (voiced > 0) parts.push(`rewrote ${voiced} into direct address`)
  if (formatted > 0) parts.push(`formatted ${formatted} as markdown`)
  if (tagged > 0) parts.push(`tagged ${tagged}`)
  if (parts.length === 0) return ''
  const last = parts.pop() as string
  return `${model} ${parts.length > 0 ? `${parts.join(', ')} and ` : ''}${last}.`
}
