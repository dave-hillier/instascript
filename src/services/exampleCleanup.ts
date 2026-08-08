// Story 8.19: the clean-up pass over examples already in the corpus.
//
// The tidy pass (story 5.7) only ever ran on the way in, and only over what
// an import happened to need at the time. A corpus that has been collected
// for a while carries the marks of that: scripts still titled after the file
// they arrived in, walls of prose with no sections a retrieval prompt can
// address, and tags from before the standard vocabulary (story 8.17) existed.
// Clean up is that work done on demand, over one example or a whole folder.
//
// Three jobs, in the order they depend on each other: retitle, then section
// (the sectioning is told the title the script now has), then tag (the
// tagging sees the section headings). Each is skipped where there is nothing
// to do, each is independent, and each is checked in code before it is
// stored — a reply that lost the script's words, or that answered with an
// essay where a title was asked for, leaves that part of the example alone.

import type { ExampleRecord, ExampleSectionSpec } from '../types/example'
import type { UtilityModelService } from './utilityModelService'
import type { ImportFileProgress } from './importProgress'
import {
  buildExampleSectioningPrompt,
  buildExampleTaggingPrompt,
  buildExampleTitlePrompt,
  buildTaggingInput
} from './prompts'
import {
  bodyWordCount,
  parseSuggestedTags,
  rewriteTokenBudget,
  stripCodeFence
} from './importAssist'
import {
  isWellFormedSplit,
  parseTranscriptSplit,
  renderSplitContent,
  splitSpecs,
  splitWordCount,
  type TranscriptSplit
} from './transcriptImport'
import { canonicalizeTags, standardTagsIn } from './standardTags'

export type CleanupJob = 'retitling' | 'sectioning' | 'tagging'

// Below this there is no script to find stages in, and the request would cost
// more than it returns. The same floor the transcript split uses.
const MIN_SECTIONING_LENGTH = 400

// A title is a handful of words. Anything longer is a first line of prose
// standing in for one, whichever end it came from.
const MAX_TITLE_LENGTH = 72
const MAX_TITLE_WORDS = 12

// The marks a file system leaves on a title: the extension it was saved
// under, the number it was ordered by, and the underscores that stood in for
// the spaces
const IMPORT_EXTENSION = /\.(md|markdown|txt|text)$/i
const ORDERING_PREFIX = /^(\d{2,4}[-_.]\d{1,2}[-_.]\d{1,2}|\d{1,3})[\s._-]+\S/

// --- What each example still needs ---------------------------------------

// Pure: whether a title reads as the name of a file rather than as a title
// somebody chose. Everything here is a mark of the file it arrived in; a
// title that carries none of them is left alone, since a title the user
// wrote is not the pass's to improve on.
export function needsRetitling(title: string): boolean {
  const trimmed = title.trim()
  if (!trimmed) return true
  if (IMPORT_EXTENSION.test(trimmed)) return true
  if (ORDERING_PREFIX.test(trimmed)) return true
  if (trimmed.includes('_')) return true
  // A slug: hyphens where the spaces should be
  if (!/\s/.test(trimmed) && /\w-\w/.test(trimmed)) return true
  if (trimmed.length > MAX_TITLE_LENGTH) return true
  // Typed at a shell rather than written: no capital anywhere in it. Only
  // said of a title actually written in a cased alphabet.
  return /[a-z]/.test(trimmed) && trimmed === trimmed.toLowerCase()
}

// Pure: whether an example is missing the section structure a generated
// script has. Sections are the pair of a heading and its spec, and the spec
// is the half that cannot be read back out of the markdown — so an example
// carrying `## ` headings and no specs still has this to gain.
export function needsSectioning(example: ExampleRecord): boolean {
  if (example.content.trim().length < MIN_SECTIONING_LENGTH) return false
  return !example.sections || example.sections.length === 0
}

// Pure: whether an example is tagged the way the corpus tags things now. A
// script tagged before the standard vocabulary existed carries topic tags
// only, and is as unfindable by explicitness or audience as an untagged one.
export function needsTagging(example: ExampleRecord): boolean {
  return standardTagsIn(example.tags).length === 0
}

// Pure: the jobs one example would gain from, in the order they run. An
// example that needs none of them costs no requests and is not offered the
// button.
export function cleanupJobsFor(example: ExampleRecord): CleanupJob[] {
  const jobs: CleanupJob[] = []
  if (needsRetitling(example.title)) jobs.push('retitling')
  if (needsSectioning(example)) jobs.push('sectioning')
  if (needsTagging(example)) jobs.push('tagging')
  return jobs
}

// --- Checking what came back ---------------------------------------------

// Pure: the title from a model reply, with the heading marker, the label, the
// quotes and the full stop a smaller model wraps it in taken off. Returns ''
// for a reply that answered with something other than a title.
export function parseSuggestedTitle(text: string): string {
  const firstLine = stripCodeFence(text)
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? ''

  const title = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(?:title|suggested title)\s*[:–—-]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`*]+$/g, '')
    .replace(/[.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title || title.length > MAX_TITLE_LENGTH) return ''
  if (!/\p{L}/u.test(title)) return ''
  if (title.split(' ').length > MAX_TITLE_WORDS) return ''
  return title
}

// Sectioning adds headings and specs to a script that is already written, so
// unlike a transcript split it has nothing to legitimately drop. The band is
// narrow on both sides: below it the model summarised, above it the model
// wrote prose of its own.
const MIN_SECTIONED_WORD_RATIO = 0.95
const MAX_SECTIONED_WORD_RATIO = 1.02

// Pure: whether a sectioning may replace the example. It has to have found
// real stages, given each a spec and a body, and kept the script's words —
// headings aside, which are what the pass is there to add.
export function isFaithfulSectioning(original: string, split: TranscriptSplit): boolean {
  if (!isWellFormedSplit(split)) return false

  const originalWords = bodyWordCount(original)
  if (originalWords === 0) return false

  const ratio = splitWordCount(split) / originalWords
  return ratio >= MIN_SECTIONED_WORD_RATIO && ratio <= MAX_SECTIONED_WORD_RATIO
}

// Pure: the body with its own `# ` heading brought in line with a new title.
// A body that does not state its title is returned untouched — the title
// lives on the record, and only a body that repeats it can contradict it.
export function retitleContent(content: string, title: string): string {
  const lines = content.split('\n')
  const first = lines.findIndex(line => line.trim() !== '')
  if (first === -1 || !/^\s{0,3}#\s+\S/.test(lines[first])) return content
  lines[first] = `# ${title}`
  return lines.join('\n')
}

// --- Running the pass ----------------------------------------------------

export interface ExampleCleanup {
  title?: string
  content?: string
  sections?: ExampleSectionSpec[]
  tags?: string[]
  // Which jobs the example owes its new state to, so a run can report what
  // it did rather than only that it did something
  retitled?: boolean
  sectioned?: boolean
  tagged?: boolean
}

// Pure: whether a pass came back with anything to store
export function isEmptyCleanup(cleanup: ExampleCleanup): boolean {
  return !cleanup.retitled && !cleanup.sectioned && !cleanup.tagged
}

export interface CleanupOptions {
  signal?: AbortSignal
  // Called as each job starts, so the meter can name the request an example
  // is sitting on rather than showing an unexplained pause
  onJobStarted?: (job: CleanupJob) => void
}

// Runs the jobs one example needs. Each is independent: a failure or an
// unusable reply leaves that part of the example exactly as it was rather
// than failing the run.
export async function cleanUpExample(
  example: ExampleRecord,
  service: UtilityModelService,
  knownTags: string[],
  { signal, onJobStarted }: CleanupOptions = {}
): Promise<ExampleCleanup> {
  const jobs = cleanupJobsFor(example)
  const cleanup: ExampleCleanup = {}
  let title = example.title
  let content = example.content

  if (jobs.includes('retitling')) {
    onJobStarted?.('retitling')
    try {
      const reply = await service.complete({
        job: 'retitling',
        system: buildExampleTitlePrompt(title),
        user: buildTaggingInput(title, content),
        signal
      })
      const suggested = parseSuggestedTitle(reply)
      if (suggested && suggested !== title) {
        title = suggested
        content = retitleContent(content, suggested)
        cleanup.title = title
        cleanup.content = content
        cleanup.retitled = true
      }
    } catch (error) {
      console.warn(`Could not retitle the example "${example.title}":`, error)
    }
  }

  if (jobs.includes('sectioning')) {
    onJobStarted?.('sectioning')
    try {
      const reply = await service.complete({
        job: 'sectioning',
        system: buildExampleSectioningPrompt(title),
        // Sectioning repeats the whole script back, so the reply is as long
        // as the script is
        maxOutputTokens: rewriteTokenBudget(content),
        user: content,
        signal
      })
      const split = parseTranscriptSplit(reply)
      if (split && isFaithfulSectioning(content, split)) {
        // The title stays the record's: this pass divides the script, and
        // retitling above is the only thing that renames it
        content = renderSplitContent({ ...split, title })
        cleanup.content = content
        cleanup.sections = splitSpecs(split)
        cleanup.sectioned = true
      }
    } catch (error) {
      console.warn(`Could not divide the example "${example.title}" into sections:`, error)
    }
  }

  if (jobs.includes('tagging')) {
    onJobStarted?.('tagging')
    try {
      const reply = await service.complete({
        job: 'tagging',
        system: buildExampleTaggingPrompt(knownTags),
        user: buildTaggingInput(title, content),
        signal
      })
      const suggested = parseSuggestedTags(reply)
      if (suggested.length > 0) {
        // The suggestions lead, so the standard labels the model was asked
        // for win the one-value facets; the tags already on the example are
        // kept behind them rather than thrown away
        cleanup.tags = canonicalizeTags([...suggested, ...example.tags])
        cleanup.tagged = true
      }
    } catch (error) {
      console.warn(`Could not suggest tags for the example "${example.title}":`, error)
    }
  }

  return cleanup
}

// The rows the clean-up meter is drawn from. Examples rather than files, so
// the row is keyed by the example it is cleaning and named by its title.
export function createCleanupProgress(examples: ExampleRecord[]): ImportFileProgress[] {
  return examples.map(example => ({
    id: example.id,
    path: example.title,
    name: example.title,
    stage: 'queued',
    exampleId: example.id
  }))
}

export interface CleanupOutcome {
  retitled: number
  sectioned: number
  tagged: number
  // Examples the model was asked about and had nothing usable to say on
  unchanged: number
}

// Pure: the running total after one example. Kept here so the page adds up
// what happened the same way the tests do.
export function recordCleanup(
  outcome: CleanupOutcome,
  cleanup: ExampleCleanup
): CleanupOutcome {
  return {
    retitled: outcome.retitled + (cleanup.retitled ? 1 : 0),
    sectioned: outcome.sectioned + (cleanup.sectioned ? 1 : 0),
    tagged: outcome.tagged + (cleanup.tagged ? 1 : 0),
    unchanged: outcome.unchanged + (isEmptyCleanup(cleanup) ? 1 : 0)
  }
}

export const EMPTY_CLEANUP_OUTCOME: CleanupOutcome = {
  retitled: 0,
  sectioned: 0,
  tagged: 0,
  unchanged: 0
}

// Pure: the status line for what the utility model made of the examples
export function describeCleanupOutcome(
  { retitled, sectioned, tagged, unchanged }: CleanupOutcome,
  model: string
): string {
  const parts: string[] = []
  if (retitled > 0) parts.push(`retitled ${retitled}`)
  if (sectioned > 0) parts.push(`divided ${sectioned} into sections`)
  if (tagged > 0) parts.push(`tagged ${tagged}`)
  if (unchanged > 0) parts.push(`left ${unchanged} unchanged`)
  if (parts.length === 0) return ''
  const last = parts.pop() as string
  return `${model} ${parts.length > 0 ? `${parts.join(', ')} and ` : ''}${last}.`
}
