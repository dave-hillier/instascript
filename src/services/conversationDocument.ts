import type { Generation, RawConversation, ScriptOutline, OutlineSection } from '../types/conversation'

// Pure helpers for reading the consolidated document state out of a raw
// conversation: generation 0 (or a later retry) holds the outline, and
// subsequent generations hold "## Section" bodies that replace earlier
// sections with the same title.

export interface DocumentSection {
  title: string
  content: string
}

export function parseOutline(text: string): ScriptOutline | null {
  const lines = text.trim().split('\n')
  const titleMatch = lines[0]?.match(/^#\s+(.+)$/)
  if (!titleMatch) return null

  const title = titleMatch[1].trim()
  const sections: OutlineSection[] = []
  let currentSectionTitle = ''

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const sectionMatch = line.match(/^##\s+(.+)$/)
    if (sectionMatch) {
      // If we had a previous section without a description, add it
      if (currentSectionTitle && !sections.find(s => s.title === currentSectionTitle)) {
        sections.push({ title: currentSectionTitle, description: '' })
      }
      currentSectionTitle = sectionMatch[1].trim()
    } else if (currentSectionTitle && line.trim() && !sections.find(s => s.title === currentSectionTitle)) {
      sections.push({ title: currentSectionTitle, description: line.trim() })
    }
  }

  // Handle last section if no description was found
  if (currentSectionTitle && !sections.find(s => s.title === currentSectionTitle)) {
    sections.push({ title: currentSectionTitle, description: '' })
  }

  if (sections.length === 0) return null
  return { title, sections }
}

// Outline generations begin with a document-level "# Title" heading;
// section generations begin with "## Section".
export function isOutlineResponse(text: string): boolean {
  return /^#(?!#)/.test(text.trimStart())
}

// A generation every one of whose calls was rejected contributed nothing to
// the script: its body was sent back to be rewritten. It lives here, in the
// lowest module both folds already depend on, so the projection and the
// consolidation below cannot drift about which drafts count.
export const isRejectedGeneration = (generation: Generation): boolean =>
  !!generation.toolCalls &&
  generation.toolCalls.length > 0 &&
  generation.toolCalls.every(call => call.status === 'rejected')

export function parseMarkdownSections(text: string): DocumentSection[] {
  const lines = text.split('\n')
  const sections: DocumentSection[] = []
  let currentTitle: string | null = null
  let currentLines: string[] = []

  const flush = () => {
    if (currentTitle !== null) {
      sections.push({ title: currentTitle, content: currentLines.join('\n').trim() })
    }
  }

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/)
    if (match) {
      flush()
      currentTitle = match[1]
      currentLines = []
    } else if (currentTitle !== null) {
      currentLines.push(line)
    }
  }
  flush()

  return sections
}

// The most recent parseable outline wins: a retried conversation can contain
// a fresh outline after earlier sections.
export function getLatestOutline(conversation: RawConversation): ScriptOutline | null {
  let outline: ScriptOutline | null = null
  for (const generation of conversation.generations) {
    const parsed = parseOutline(generation.response)
    if (parsed) outline = parsed
  }
  return outline
}

// The current state of every section: later generations (regenerations and
// refinements) replace earlier sections with the same title.
//
// This is the second fold of a conversation, next to projectConversation's:
// that one builds the document a reader sees, this one the section text the
// prompts, the review pass and the filesystem export work from. They must
// agree about what is in the script, so both skip a wholly rejected
// generation. Without that a run that ends on a refusal — an abort or a
// failure between a rejection and its rewrite — leaves a refused draft as the
// last generation for its title, and this fold would hand it to the review
// pass as the section's prose and write it back as script content.
export function consolidateSections(conversation: RawConversation): DocumentSection[] {
  const consolidated: DocumentSection[] = []

  for (const generation of conversation.generations) {
    if (isRejectedGeneration(generation)) continue
    if (isOutlineResponse(generation.response)) continue

    for (const section of parseMarkdownSections(generation.response)) {
      const existingIndex = consolidated.findIndex(s => s.title === section.title)
      if (existingIndex >= 0) {
        consolidated[existingIndex] = section
      } else {
        consolidated.push(section)
      }
    }
  }

  return consolidated
}

// Section generations are stored with their "## Title" header so that
// consolidation-by-title can find them. Models are asked to output only the
// body, but if one emits the header anyway, don't double it.
export function ensureSectionHeading(sectionTitle: string, text: string): string {
  return /^##\s/.test(text.trimStart()) ? text : `## ${sectionTitle}\n${text}`
}
