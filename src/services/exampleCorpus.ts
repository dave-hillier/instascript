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

export function deleteUserExample(id: string): void {
  if (!id.startsWith(EXAMPLE_KEY_PREFIX)) return
  window.localStorage.removeItem(id)
}

export function updateUserExampleTags(id: string, tags: string[]): void {
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (!example) return
  saveUserExample({ ...example, tags })
}
