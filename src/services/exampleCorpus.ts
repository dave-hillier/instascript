import YAML from 'yaml'
import type { ExampleRecord } from '../types/example'
import { BUNDLED_EXAMPLE_SCRIPTS } from '../data/bundledExampleScripts'

// User-imported examples live in localStorage under example_* keys as YAML
// front matter + markdown, matching the script storage format. Bundled and
// user examples are merged at search time.

export const EXAMPLE_KEY_PREFIX = 'example_'

interface ParsedExampleFile {
  title: string
  tags: string[]
  content: string
  createdAt?: number
  embedding?: number[]
}

// Parses a markdown example file: optional YAML front matter (title, tags),
// then the script body. Falls back to the first "# Title" heading, then to
// the supplied fallback (typically the filename without extension).
export function parseExampleMarkdown(raw: string, fallbackTitle: string): ParsedExampleFile {
  let title: string | undefined
  let tags: string[] = []
  let createdAt: number | undefined
  let embedding: number[] | undefined
  let content = raw

  const frontMatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (frontMatterMatch) {
    try {
      const parsed = YAML.parse(frontMatterMatch[1]) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.title === 'string') title = parsed.title
        if (Array.isArray(parsed.tags)) {
          tags = parsed.tags.map(String).map(tag => tag.trim()).filter(Boolean)
        } else if (typeof parsed.tags === 'string') {
          tags = parseTags(parsed.tags)
        }
        if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt
        if (
          Array.isArray(parsed.embedding) &&
          parsed.embedding.length > 0 &&
          parsed.embedding.every(value => typeof value === 'number')
        ) {
          embedding = parsed.embedding as number[]
        }
        content = frontMatterMatch[2].trim()
      }
    } catch {
      // Malformed front matter: treat the whole file as content
    }
  }

  if (!title) {
    const heading = content.trimStart().split('\n', 1)[0].match(/^#\s+(.+)$/)
    title = heading ? heading[1].trim() : fallbackTitle
  }

  return { title, tags, content: content.trim(), createdAt, embedding }
}

export function serializeExampleToMarkdown(example: ExampleRecord): string {
  const frontMatter: Record<string, unknown> = {
    title: example.title,
    tags: example.tags,
    createdAt: example.createdAt ?? Date.now()
  }
  if (example.embedding && example.embedding.length > 0) {
    // Rounded to 5 decimals: enough precision for cosine similarity, keeps
    // the stored front matter compact
    frontMatter.embedding = example.embedding.map(
      value => Math.round(value * 1e5) / 1e5
    )
  }
  const serialized = YAML.stringify(frontMatter).trim()
  return `---\n${serialized}\n---\n${example.content}\n`
}

// Splits a comma-separated tag string into clean tags
export function parseTags(value: string): string[] {
  return value
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean)
}

export function getUserExamples(): ExampleRecord[] {
  try {
    const examples: ExampleRecord[] = []
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(EXAMPLE_KEY_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      const parsed = parseExampleMarkdown(raw, key.slice(EXAMPLE_KEY_PREFIX.length))
      examples.push({
        id: key,
        title: parsed.title,
        tags: parsed.tags,
        content: parsed.content,
        source: 'user',
        createdAt: parsed.createdAt,
        embedding: parsed.embedding
      })
    }
    return examples.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  } catch (error) {
    console.warn('Error loading user examples from localStorage:', error)
    return []
  }
}

// Every example the app knows about, whether or not the bundled corpus is
// switched on. Used for display and for resolving example ids back to titles.
export function getAllExamples(): ExampleRecord[] {
  return [...BUNDLED_EXAMPLE_SCRIPTS, ...getUserExamples()]
}

// --- Bundled corpus opt-out --------------------------------------------
// The shipped examples can be switched off so that generation is grounded
// only in the user's own scripts. Bundled examples stay listed (and stay
// available for id lookups) when disabled; they are just excluded from
// retrieval.

export const BUNDLED_EXAMPLES_ENABLED_KEY = 'bundledExamplesEnabled'

export function areBundledExamplesEnabled(): boolean {
  try {
    const item = window.localStorage.getItem(BUNDLED_EXAMPLES_ENABLED_KEY)
    return item ? JSON.parse(item) !== false : true
  } catch (error) {
    console.warn('Error loading bundled examples setting from localStorage:', error)
    return true
  }
}

export function setBundledExamplesEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(BUNDLED_EXAMPLES_ENABLED_KEY, JSON.stringify(enabled))
  } catch (error) {
    console.warn('Error saving bundled examples setting to localStorage:', error)
  }
}

// The examples retrieval is allowed to draw on
export function getEnabledExamples(): ExampleRecord[] {
  const user = getUserExamples()
  if (!areBundledExamplesEnabled()) return user
  return [...BUNDLED_EXAMPLE_SCRIPTS, ...user]
}

function saveUserExample(example: ExampleRecord): void {
  window.localStorage.setItem(example.id, serializeExampleToMarkdown(example))
}

// Computes and stores the example's embedding. Fire-and-forget from the sync
// import/promotion paths: retrieval works without the embedding (pure BM25)
// until it lands, and never blocks on the model loading.
async function attachEmbedding(example: ExampleRecord): Promise<void> {
  try {
    const { embedText, embeddingInputForExample } = await import('./embeddingService')
    const embedding = await embedText(embeddingInputForExample(example))
    if (!embedding) return
    saveUserExample({ ...example, embedding })
  } catch (error) {
    console.warn('Could not compute example embedding:', error)
  }
}

// Migration: user examples saved before embeddings existed get theirs
// computed once, in the background, the next time the corpus is touched
export async function backfillMissingEmbeddings(): Promise<void> {
  for (const example of getUserExamples()) {
    if (example.embedding) continue
    await attachEmbedding(example)
  }
}

function createUserExample(title: string, tags: string[], content: string): ExampleRecord {
  const example: ExampleRecord = {
    id: `${EXAMPLE_KEY_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    title,
    tags,
    content,
    source: 'user',
    createdAt: Date.now()
  }
  saveUserExample(example)
  void attachEmbedding(example)
  return example
}

// Extensions accepted when importing examples. Plain text is treated the
// same as markdown: front matter and a leading heading are honoured if
// present, otherwise the whole file is the script body.
const IMPORTABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.text']

// Pure: whether a file (possibly deep inside an imported folder) looks like
// an example we can read. Hidden files and anything non-textual are skipped
// so that dropping a whole folder does not import stray assets.
export function isImportableExampleFile(path: string): boolean {
  const name = path.split('/').pop() ?? path
  if (name.startsWith('.')) return false
  return IMPORTABLE_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension))
}

// Imports a markdown or plain text file as a user example. Accepts a path
// (as folder imports supply) and titles from the file name alone.
export function importExampleFile(filename: string, text: string): ExampleRecord {
  const name = filename.split('/').pop() ?? filename
  const fallbackTitle = name.replace(/\.(md|markdown|txt|text)$/i, '')
  const parsed = parseExampleMarkdown(text, fallbackTitle)
  return createUserExample(parsed.title, parsed.tags, parsed.content)
}

// Promotes a completed script's consolidated content to a user example
export function promoteScriptToExample(
  title: string,
  content: string,
  tags: string[] = []
): ExampleRecord {
  return createUserExample(title, tags, content)
}

// --- Example selection counts (story 8.11) -------------------------------
// How many generation runs each example has been selected for, keyed by
// example id. Kept as one JSON map in localStorage alongside the corpus so
// counts cover bundled and user examples alike, and included in the library
// export so they survive moving browsers.

export const SELECTION_COUNTS_KEY = 'exampleSelectionCounts'

// Pure: parses a stored counts map, dropping anything that is not a
// positive finite number
export function parseSelectionCounts(raw: string | null): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return sanitizeSelectionCounts(parsed)
  } catch {
    return {}
  }
}

// Pure: keeps only entries whose value is a positive finite number
export function sanitizeSelectionCounts(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const counts: Record<string, number> = {}
  for (const [id, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      counts[id] = Math.floor(count)
    }
  }
  return counts
}

// Pure: one more selection recorded for each of the given example ids
export function incrementSelectionCounts(
  counts: Record<string, number>,
  exampleIds: string[]
): Record<string, number> {
  const next = { ...counts }
  for (const id of exampleIds) {
    next[id] = (next[id] ?? 0) + 1
  }
  return next
}

// Pure: merges imported counts into existing ones. An import never lowers a
// count, and re-importing the same file does not inflate it — each id keeps
// the higher of the two values.
export function mergeSelectionCounts(
  existing: Record<string, number>,
  imported: Record<string, number>
): Record<string, number> {
  const merged = { ...existing }
  for (const [id, count] of Object.entries(imported)) {
    if (count > (merged[id] ?? 0)) {
      merged[id] = count
    }
  }
  return merged
}

export function getExampleSelectionCounts(): Record<string, number> {
  try {
    return parseSelectionCounts(window.localStorage.getItem(SELECTION_COUNTS_KEY))
  } catch (error) {
    console.warn('Error loading example selection counts:', error)
    return {}
  }
}

function saveExampleSelectionCounts(counts: Record<string, number>): void {
  window.localStorage.setItem(SELECTION_COUNTS_KEY, JSON.stringify(counts))
}

// Records that these examples were selected for one generation run
export function recordExampleSelections(exampleIds: string[]): void {
  if (exampleIds.length === 0) return
  // The orchestrator also runs under test in Node, where there is no storage
  if (typeof window === 'undefined') return
  try {
    saveExampleSelectionCounts(
      incrementSelectionCounts(getExampleSelectionCounts(), exampleIds)
    )
  } catch (error) {
    console.warn('Error recording example selections:', error)
  }
}

// Applies counts arriving from a library import (story 7.2 round-trip)
export function importExampleSelectionCounts(imported: Record<string, number>): void {
  try {
    saveExampleSelectionCounts(
      mergeSelectionCounts(getExampleSelectionCounts(), sanitizeSelectionCounts(imported))
    )
  } catch (error) {
    console.warn('Error importing example selection counts:', error)
  }
}

export function deleteUserExample(id: string): void {
  if (!id.startsWith(EXAMPLE_KEY_PREFIX)) return
  window.localStorage.removeItem(id)
  // A deleted example's selection history goes with it
  try {
    const counts = getExampleSelectionCounts()
    if (id in counts) {
      delete counts[id]
      saveExampleSelectionCounts(counts)
    }
  } catch (error) {
    console.warn('Error clearing selection count for deleted example:', error)
  }
}

export function updateUserExampleTags(id: string, tags: string[]): void {
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (!example) return
  saveUserExample({ ...example, tags })
}

// Applies what the utility model made of an import (story 5.7). Rewritten
// content invalidates the embedding computed from the original text, so it is
// recomputed in the background the same way an import does.
export function applyExampleEnhancement(
  id: string,
  enhancement: { tags?: string[]; content?: string }
): ExampleRecord | null {
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (!example) return null

  const updated: ExampleRecord = {
    ...example,
    tags: enhancement.tags ?? example.tags,
    content: enhancement.content ?? example.content
  }
  saveUserExample(updated)

  if (enhancement.content && enhancement.content !== example.content) {
    void attachEmbedding(updated)
  }

  return updated
}

// Every tag in use across the corpus, most-used first — the vocabulary the
// utility model is offered so suggestions converge instead of sprawling
export function getKnownTags(): string[] {
  const counts = new Map<string, number>()
  for (const example of getAllExamples()) {
    for (const tag of example.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
}
