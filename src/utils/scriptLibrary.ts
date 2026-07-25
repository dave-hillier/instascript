import type { Script } from '../types/script'

export type SortOrder = 'newest' | 'oldest'

// Parses a sort order from a URL query value; anything unrecognised
// falls back to the default of newest first
export function parseSortOrder(value: string | null): SortOrder {
  return value === 'oldest' ? 'oldest' : 'newest'
}

// Best-effort creation timestamp for a script. Ids are minted as
// `script_<epoch-ms>_<random>`, which is the most reliable source;
// `createdAt` is a display string and only parseable in some locales.
export function getScriptTimestamp(script: Script): number {
  const match = script.id.match(/^script_(\d+)_/)
  if (match) return Number(match[1])
  const parsed = Date.parse(script.createdAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

// Case-insensitive filter over title and initial prompt.
// A blank query returns the list unchanged.
export function filterScriptsByQuery(scripts: Script[], query: string): Script[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return scripts
  return scripts.filter(script =>
    script.title.toLowerCase().includes(needle) ||
    (script.initialPrompt ?? '').toLowerCase().includes(needle)
  )
}

// Status for a duplicated script (story 4.3). The copy never inherits a
// running generation, so an in-progress source duplicates as a draft
// holding whatever content has streamed so far; otherwise the status is
// derived from whether any content exists.
export function duplicateScriptStatus(
  source: Pick<Script, 'status' | 'content'>
): NonNullable<Script['status']> {
  if (source.status === 'in-progress') return 'draft'
  return source.content.trim() ? 'complete' : 'draft'
}

// Returns a new array sorted by creation time; ties keep their input order
export function sortScriptsByCreation(scripts: Script[], order: SortOrder): Script[] {
  const direction = order === 'oldest' ? 1 : -1
  return [...scripts].sort(
    (a, b) => direction * (getScriptTimestamp(a) - getScriptTimestamp(b))
  )
}
