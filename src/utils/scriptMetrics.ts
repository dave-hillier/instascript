const WORDS_PER_MINUTE = 130

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length
}

// Formats a word count as a human string, e.g. "2,140 words · ~16 min" at ~130 wpm
export function formatScriptLength(wordCount: number): string {
  const words = wordCount.toLocaleString('en-US')
  const wordLabel = wordCount === 1 ? 'word' : 'words'
  const minutes = Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))
  return `${words} ${wordLabel} · ~${minutes} min`
}

// Extracts the document title from a markdown document whose first line is "# Title"
export function extractDocumentTitle(markdown: string): string | null {
  const firstLine = markdown.trimStart().split('\n', 1)[0]
  const match = firstLine.match(/^#\s+(.+)$/)
  return match ? match[1].trim() : null
}
