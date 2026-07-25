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

export function getAllExamples(): ExampleRecord[] {
  return [...BUNDLED_EXAMPLE_SCRIPTS, ...getUserExamples()]
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

// Imports a markdown file as a user example
export function importExampleFile(filename: string, text: string): ExampleRecord {
  const fallbackTitle = filename.replace(/\.(md|markdown)$/i, '')
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
