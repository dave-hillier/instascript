import type { RawConversation, ScriptOutline, OutlineSection } from '../types/conversation'

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
export function consolidateSections(conversation: RawConversation): DocumentSection[] {
  const consolidated: DocumentSection[] = []

  for (const generation of conversation.generations) {
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
