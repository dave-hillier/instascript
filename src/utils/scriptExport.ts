import type { RawConversation } from '../types/conversation'
import { consolidateSections, isOutlineResponse } from '../services/conversationDocument'
import { extractDocumentTitle } from './scriptMetrics'

// The full consolidated script as markdown: the document title, then every
// section in its current state — later regenerations and manual edits replace
// earlier sections with the same title. The title comes from the most recent
// outline unless a preferredTitle is given (the stored script title once the
// script is complete, so manual renames carry through to the export).
export function buildConsolidatedMarkdown(
  conversation: RawConversation,
  fallbackTitle?: string,
  preferredTitle?: string
): string {
  let title = fallbackTitle
  if (preferredTitle) {
    title = preferredTitle
  } else {
    for (const generation of conversation.generations) {
      if (isOutlineResponse(generation.response)) {
        title = extractDocumentTitle(generation.response) ?? title
      }
    }
  }

  const sections = consolidateSections(conversation)
  if (sections.length === 0) return ''

  return [
    title ? `# ${title}` : '',
    ...sections.map(section => `## ${section.title}\n${section.content}`)
  ].filter(Boolean).join('\n\n')
}

// A safe download filename derived from the script title, e.g.
// "A Quiet Descent" -> "a-quiet-descent.md"
export function markdownFilename(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return `${base || 'script'}.md`
}
