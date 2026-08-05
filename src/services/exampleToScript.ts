// Opening a corpus example as a script (story 8.16). An example is a piece
// of markdown; a script is a library entry backed by a conversation, and
// everything the script page offers — section regeneration, refinement,
// review, performance mode, export — reads that conversation rather than the
// text. So the conversion is a reconstruction: the example's sections become
// the section generations the script page expects, and a synthesised outline
// generation gives them the plan the regeneration prompts read from.
//
// Everything here is pure. The script and the conversation are built from an
// example plus the ids the caller minted, so the whole conversion is testable
// without storage.

import type { ExampleRecord } from '../types/example'
import type { Generation } from '../types/conversation'
import type { Script } from '../types/script'
import { clampTargetMinutes } from './scriptLength'
import { countWords, estimateSpokenMinutes, extractDocumentTitle } from '../utils/scriptMetrics'

// What an unstructured example becomes: one section holding the whole thing,
// rather than a script with no sections at all, which the page cannot edit
export const WHOLE_SCRIPT_SECTION_TITLE = 'The script'

// Prose sitting above the first heading is script too, so it gets a section
// of its own rather than being dropped on the floor
export const OPENING_SECTION_TITLE = 'Opening'

// How much of a section's own text stands in for its outline entry. A
// regeneration reads that entry as the section's brief, so it needs to say
// what the section does, not merely that it exists.
const OUTLINE_DESCRIPTION_WORDS = 25

const SECTION_HEADING = /^##\s+(.+?)\s*$/

export interface ConvertedSection {
  title: string
  content: string
}

export interface ExampleConversion {
  title: string
  sections: ConvertedSection[]
  // The outline generation's text: "# Title" plus a "## Section" entry per
  // section, each with a description read back from the section itself
  outline: string
  wordCount: number
  // The spoken length the script is treated as having been written for, so a
  // later review judges it against its own length rather than the default
  targetMinutes: number
}

// Pure: the script's own body, without the "# Title" line the title is taken
// from. Anything else — including deeper headings — is left alone.
export function stripDocumentTitle(content: string): string {
  const trimmed = content.trimStart()
  if (!/^#(?!#)\s+/.test(trimmed)) return content.trim()
  return trimmed.split('\n').slice(1).join('\n').trim()
}

// Pure: a title no earlier section has taken. Sections are consolidated by
// title, so two sections sharing one would collapse into a single section and
// the example would lose text on the way in.
export function distinctSectionTitle(title: string, taken: string[]): string {
  if (!taken.includes(title)) return title
  let suffix = 2
  while (taken.includes(`${title} (${suffix})`)) suffix += 1
  return `${title} (${suffix})`
}

// Pure: the example's body split at its "## " headings. A body with no
// headings at all is one section; prose above the first heading is a section
// too, so every word of the example survives the conversion.
export function splitExampleSections(body: string): ConvertedSection[] {
  const sections: ConvertedSection[] = []
  const titles: string[] = []
  let title: string | null = null
  let buffer: string[] = []
  let sawHeading = false

  const flush = () => {
    const content = buffer.join('\n').trim()
    buffer = []
    if (title === null) {
      if (!content) return
      title = OPENING_SECTION_TITLE
    }
    const distinct = distinctSectionTitle(title, titles)
    titles.push(distinct)
    sections.push({ title: distinct, content })
  }

  for (const line of body.split('\n')) {
    const match = line.match(SECTION_HEADING)
    if (match) {
      flush()
      sawHeading = true
      title = match[1]
    } else {
      buffer.push(line)
    }
  }
  flush()

  // An example with no headings is one unstructured block, and calling that
  // block "Opening" would be a lie about a script that is all of it
  if (!sawHeading && sections.length === 1) {
    return [{ title: WHOLE_SCRIPT_SECTION_TITLE, content: sections[0].content }]
  }
  return sections
}

// Pure: the outline entry for a section — enough of its own opening for a
// regeneration to know what the section is for
function outlineDescription(content: string): string {
  const words = content
    .replace(/[#*_>]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return 'This section of the script.'
  const excerpt = words.slice(0, OUTLINE_DESCRIPTION_WORDS).join(' ')
  return words.length > OUTLINE_DESCRIPTION_WORDS ? `${excerpt} …` : excerpt
}

// Pure: everything a script needs to be reconstructed from an example
export function convertExampleToScript(
  title: string,
  content: string
): ExampleConversion {
  const documentTitle = extractDocumentTitle(content) ?? title
  const sections = splitExampleSections(stripDocumentTitle(content))
  const wordCount = sections.reduce(
    (total, section) => total + countWords(section.content),
    0
  )

  const outline = [
    `# ${documentTitle}`,
    ...sections.map(
      section => `## ${section.title}\n${outlineDescription(section.content)}`
    )
  ].join('\n\n')

  return {
    title: documentTitle,
    sections,
    outline,
    wordCount,
    targetMinutes: clampTargetMinutes(estimateSpokenMinutes(wordCount))
  }
}

// Pure: the conversation the script page reads. Generation 0 is the outline
// and the rest are sections, exactly as a generated script's conversation is
// shaped, so regeneration, refinement and review all work on the result. The
// user turns record where the text came from rather than pretending a model
// was asked for it.
export function buildConversionGenerations(
  conversion: ExampleConversion,
  sourceTitle: string,
  now: number = Date.now()
): Generation[] {
  const provenance = `Opened from the example "${sourceTitle}" in my corpus. The text below is that script as it was written, not a generation.`

  return [
    {
      messages: [{ role: 'user', content: provenance }],
      response: conversion.outline,
      timestamp: now
    },
    ...conversion.sections.map((section, index) => ({
      messages: [
        {
          role: 'user' as const,
          content: `The "${section.title}" section of that script, as it was written.`
        }
      ],
      response: `## ${section.title}\n${section.content}`,
      timestamp: now + index + 1
    }))
  ]
}

export interface AdoptedScript {
  script: Script
  generations: Generation[]
}

// Pure: the library entry and its conversation for an example being opened as
// a script. The caller mints the ids and attaches the conversation id once the
// conversation exists.
export function adoptExampleAsScript(
  example: ExampleRecord,
  scriptId: string,
  now: number = Date.now()
): AdoptedScript {
  const conversion = convertExampleToScript(example.title, example.content)

  return {
    script: {
      id: scriptId,
      title: conversion.title,
      // The document lives in the conversation, as it does for a generated
      // script; the stored content field is only ever the legacy copy
      content: '',
      createdAt: new Date(now).toLocaleDateString(),
      isArchived: false,
      status: 'complete',
      tags: example.tags.length > 0 ? [...example.tags] : undefined,
      // The brief a refinement or a review is judged against. There was no
      // brief, so it says what the script actually is.
      initialPrompt: `"${conversion.title}", opened from my example corpus. Keep its voice and structure unless I ask for something else.`,
      targetMinutes: conversion.targetMinutes,
      sourceExampleId: example.id
    },
    generations: buildConversionGenerations(conversion, example.title, now)
  }
}
