// Importing an example from the transcript of a real session. A transcript is
// not a script: it carries speaker labels, timestamps, the client's replies and
// the small talk either side of the trance, and it has no structure a reader —
// or a retrieval prompt — can address.
//
// The utility model does the one job code cannot: deciding where the session
// turns. It is handed the transcript and asked for the same shape the script
// filesystem uses — a title, then one section per stage with a spec line and
// the spoken words beneath it. Everything after that is pure: the reply is
// parsed here, and checked here, so a small model's approximate obedience is
// corrected in code rather than trusted.

import type { ExampleSectionSpec } from '../types/example'
import type { UtilityModelService } from './utilityModelService'
import { buildTranscriptSplitPrompt } from './prompts'
import { parseMarkdownSections } from './conversationDocument'
import { stripCodeFence } from './importAssist'
import { countWords } from '../utils/scriptMetrics'

// A section's spec line in the model's reply: a markdown blockquote directly
// under the heading. Distinct from prose, so it never gets mistaken for part
// of the script.
const SPEC_LINE = /^\s{0,3}>\s?(.*)$/

// Below this the "transcript" is a note or a fragment; there is no session in
// it to find stages in, and the request would cost more than it returns.
export const MIN_TRANSCRIPT_LENGTH = 400

// A session has stages; one heading over the whole thing is the model
// declining to split. The upper bound catches a model that split at every
// paragraph, which addresses nothing.
const MIN_SECTIONS = 2
const MAX_SECTIONS = 24

// A section with a couple of words under it is a heading the model invented
// and then had nothing to put beneath
const MIN_SECTION_WORDS = 15

// The split drops what was never script — labels, timestamps, the client's
// turns — so it legitimately loses words, and the floor is far below the
// formatting pass's. The ceiling is what matters: a split that grew the
// transcript wrote prose of its own, and is discarded.
const MIN_RETAINED_WORD_RATIO = 0.4
const MAX_RETAINED_WORD_RATIO = 1.05

export interface TranscriptSection extends ExampleSectionSpec {
  content: string
}

export interface TranscriptSplit {
  title: string
  sections: TranscriptSection[]
}

// Pure: the split from a model reply. Reads the title from the leading `# `
// line if there is one, then each `## ` section with its `> ` spec line and
// the prose beneath.
export function parseTranscriptSplit(text: string): TranscriptSplit | null {
  const body = stripCodeFence(text)
  if (!body) return null

  const heading = body.trimStart().split('\n', 1)[0].match(/^#\s+(.+)$/)
  const title = heading ? heading[1].trim() : ''

  const sections: TranscriptSection[] = []
  for (const section of parseMarkdownSections(body)) {
    const lines = section.content.split('\n')
    // The spec is the first non-empty line when it is a blockquote. A section
    // written without one keeps all its lines as content and is rejected
    // below rather than silently losing its opening sentence.
    let prompt = ''
    let contentLines = lines
    const firstContentIndex = lines.findIndex(line => line.trim() !== '')
    if (firstContentIndex !== -1) {
      const spec = lines[firstContentIndex].match(SPEC_LINE)
      if (spec) {
        prompt = spec[1].trim()
        contentLines = lines.slice(firstContentIndex + 1)
      }
    }

    sections.push({
      title: section.title.trim(),
      prompt,
      content: contentLines.join('\n').trim()
    })
  }

  if (sections.length === 0) return null
  return { title, sections }
}

// Pure: whether a split found real stages and gave each one a spec and a
// body. Shared with the clean-up pass (story 8.19), which asks the same shape
// of a script already in the corpus and so wants the same structural checks —
// only how many of the words are allowed to go differs between them.
export function isWellFormedSplit({ sections }: TranscriptSplit): boolean {
  if (sections.length < MIN_SECTIONS || sections.length > MAX_SECTIONS) return false
  if (sections.some(section => section.title === '' || section.prompt === '')) return false
  return sections.every(section => countWords(section.content) >= MIN_SECTION_WORDS)
}

// Pure: how many words a split holds across its sections, headings and specs
// aside — those are the split's own, not the material's
export function splitWordCount({ sections }: TranscriptSplit): number {
  return sections.reduce((total, section) => total + countWords(section.content), 0)
}

// Pure: whether a split may replace the imported transcript. It must have
// found real stages, given each one a spec and a body, and kept the session's
// words rather than summarising them.
export function isUsableSplit(transcript: string, split: TranscriptSplit): boolean {
  if (!isWellFormedSplit(split)) return false

  const transcriptWords = countWords(transcript)
  if (transcriptWords === 0) return false

  const ratio = splitWordCount(split) / transcriptWords
  return ratio >= MIN_RETAINED_WORD_RATIO && ratio <= MAX_RETAINED_WORD_RATIO
}

// Pure: whether a file is worth sending to the model at all. Anything already
// carrying `## ` headings is a script someone structured, not a raw
// transcript, and is left alone.
export function looksLikeRawTranscript(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length < MIN_TRANSCRIPT_LENGTH) return false
  return !/^\s{0,3}##\s+\S/m.test(trimmed)
}

// Pure: the example body a split becomes — the same markdown any other
// example is stored as, so retrieval and display need to know nothing about
// where it came from. The specs live in the front matter, not here: they
// describe the section rather than belonging to the script's prose.
export function renderSplitContent(split: TranscriptSplit): string {
  const blocks = split.sections.map(section => `## ${section.title}\n\n${section.content}`)
  return [split.title ? `# ${split.title}` : '', ...blocks].filter(Boolean).join('\n\n')
}

export function splitSpecs(split: TranscriptSplit): ExampleSectionSpec[] {
  return split.sections.map(({ title, prompt }) => ({ title, prompt }))
}

// Asks the utility model to split one transcript. Returns null when the model
// is unreachable, declines, or returns something that fails the checks above —
// in every case the caller keeps the transcript exactly as imported.
export async function splitTranscript(
  title: string,
  transcript: string,
  service: UtilityModelService,
  signal?: AbortSignal
): Promise<TranscriptSplit | null> {
  if (!service.isLive) return null
  if (!looksLikeRawTranscript(transcript)) return null

  try {
    const reply = await service.complete({
      job: 'transcript',
      system: buildTranscriptSplitPrompt(title),
      user: transcript,
      // A split repeats the whole transcript back, so the reply is as long as
      // the input. The default ceiling would truncate all but the shortest
      // sessions mid-section.
      maxOutputTokens: 16384,
      signal
    })
    const split = parseTranscriptSplit(reply)
    if (!split || !isUsableSplit(transcript, split)) return null
    return split
  } catch (error) {
    console.warn(`Could not split the transcript "${title}" into sections:`, error)
    return null
  }
}

export interface TranscriptImportOutcome {
  split: number
  kept: number
}

// Pure: the status line for what the utility model made of the transcripts.
// Tagging is the tidy pass's to report, not this one's.
export function describeTranscriptImport(
  { split, kept }: TranscriptImportOutcome,
  model: string
): string {
  const parts: string[] = []
  if (split > 0) parts.push(`split ${split} into sections`)
  if (kept > 0) parts.push(`left ${kept} unsplit`)
  if (parts.length === 0) return ''
  return `${model} ${parts.join(' and ')}.`
}
