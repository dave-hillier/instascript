import type { RawConversation } from '../types/conversation'
import { projectConversation } from '../services/scriptProjection'

// The full consolidated script as markdown: the document title, then every
// section in its current state — later regenerations and manual edits replace
// earlier sections with the same title. Built from the same projection the
// reading view renders, so what is exported is what was on screen. The title
// comes from the most recent outline unless a preferredTitle is given (the
// stored script title once the script is complete, so manual renames carry
// through to the export).
export function buildConsolidatedMarkdown(
  conversation: RawConversation,
  fallbackTitle?: string,
  preferredTitle?: string
): string {
  const { title: outlineTitle, sections } = projectConversation(conversation)
  if (sections.length === 0) return ''

  // An empty preferred title is not a title. `??` would let '' win and drop
  // the heading entirely, so the falsiness check the old branch had is kept.
  const title = (preferredTitle || undefined) ?? outlineTitle ?? fallbackTitle

  return [
    title ? `# ${title}` : '',
    ...sections.map(section => `## ${section.title}\n${section.content}`)
  ].filter(Boolean).join('\n\n')
}

// A safe download filename stem derived from the script title, e.g.
// "A Quiet Descent" -> "a-quiet-descent"
function filenameStem(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return stem || 'script'
}

export function markdownFilename(title: string): string {
  return `${filenameStem(title)}.md`
}

// The recorded read-aloud (story 4.6), which is written as WAV.
export function audioFilename(title: string): string {
  return `${filenameStem(title)}.wav`
}
