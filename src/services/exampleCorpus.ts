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
  folder?: string
  createdAt?: number
  embedding?: number[]
}

// Parses a markdown example file: optional YAML front matter (title, tags),
// then the script body. Falls back to the first "# Title" heading, then to
// the supplied fallback (typically the filename without extension).
export function parseExampleMarkdown(raw: string, fallbackTitle: string): ParsedExampleFile {
  let title: string | undefined
  let tags: string[] = []
  let folder: string | undefined
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
        if (typeof parsed.folder === 'string') folder = normalizeFolderName(parsed.folder) || undefined
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

  return { title, tags, folder, content: content.trim(), createdAt, embedding }
}

export function serializeExampleToMarkdown(example: ExampleRecord): string {
  const frontMatter: Record<string, unknown> = {
    title: example.title,
    tags: example.tags,
    createdAt: example.createdAt ?? Date.now()
  }
  // Unfiled examples carry no folder key, so anything imported before
  // folders existed round-trips unchanged
  const folder = example.folder ? normalizeFolderName(example.folder) : ''
  if (folder && folder !== UNFILED_FOLDER) {
    frontMatter.folder = folder
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

// --- Folders --------------------------------------------------------------
// User examples are filed into folders, and exactly one folder at a time is
// the one retrieval draws on. Folders come from imports (a folder import
// files its scripts under the folder they came from) and can be changed per
// example afterwards. Examples with no folder — everything imported before
// folders existed — belong to the unfiled folder, which is what a fresh
// install and every upgraded install start on.

export const UNFILED_FOLDER = 'Unfiled'
export const ACTIVE_EXAMPLE_FOLDER_KEY = 'activeExampleFolder'

const MAX_FOLDER_NAME_LENGTH = 64

// Pure: a folder name reduced to what is stored and compared — no path
// separators, no runs of whitespace, bounded length. Returns '' for a name
// that is nothing but punctuation or blanks, which callers read as unfiled.
export function normalizeFolderName(value: string): string {
  return value
    .replace(/[\\/]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    .trim()
}

// Pure: the folder an example is filed under, resolving the absent case
export function exampleFolder(example: ExampleRecord): string {
  const folder = example.folder ? normalizeFolderName(example.folder) : ''
  return folder || UNFILED_FOLDER
}

// Pure: the folder an imported file is filed under — the directory it sits
// in, so importing a folder of categorised subfolders yields one folder per
// subfolder rather than lumping them together. Files chosen individually
// carry no path and are unfiled.
export function folderFromImportPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return UNFILED_FOLDER
  return normalizeFolderName(segments[segments.length - 2]) || UNFILED_FOLDER
}

// Pure: every folder in use, alphabetically, with the unfiled catch-all last
export function listExampleFolders(examples: ExampleRecord[]): string[] {
  const folders = new Set(examples.map(exampleFolder))
  const named = [...folders]
    .filter(folder => folder !== UNFILED_FOLDER)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
  return folders.has(UNFILED_FOLDER) ? [...named, UNFILED_FOLDER] : named
}

// Pure: which folder is actually active, given what is stored and which
// folders exist. A stored folder that has since been deleted (or was never
// created, as on a fresh install) falls back to the unfiled folder, then to
// whatever folder does exist, so retrieval is never left pointing at nothing.
export function resolveActiveFolder(folders: string[], stored: string | null): string {
  const target = stored ? normalizeFolderName(stored) : UNFILED_FOLDER
  if (folders.includes(target)) return target
  if (folders.includes(UNFILED_FOLDER)) return UNFILED_FOLDER
  return folders[0] ?? UNFILED_FOLDER
}

function getStoredActiveFolder(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_EXAMPLE_FOLDER_KEY)
  } catch (error) {
    console.warn('Error loading the active example folder from localStorage:', error)
    return null
  }
}

// The folder retrieval draws on, resolved against the folders that exist
export function getActiveExampleFolder(): string {
  return resolveActiveFolder(listExampleFolders(getUserExamples()), getStoredActiveFolder())
}

export function setActiveExampleFolder(folder: string): void {
  try {
    window.localStorage.setItem(
      ACTIVE_EXAMPLE_FOLDER_KEY,
      normalizeFolderName(folder) || UNFILED_FOLDER
    )
  } catch (error) {
    console.warn('Error saving the active example folder to localStorage:', error)
  }
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
        folder: parsed.folder,
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

// --- Bundled corpus opt-in ---------------------------------------------
// The shipped examples are placeholder stubs, so they stay out of retrieval
// unless switched on and generation is grounded in the user's own scripts.
// They stay listed (and stay available for id lookups) when disabled; they
// are just excluded from retrieval.

export const BUNDLED_EXAMPLES_ENABLED_KEY = 'bundledExamplesEnabled'

export function areBundledExamplesEnabled(): boolean {
  try {
    const item = window.localStorage.getItem(BUNDLED_EXAMPLES_ENABLED_KEY)
    return item ? JSON.parse(item) === true : false
  } catch (error) {
    console.warn('Error loading bundled examples setting from localStorage:', error)
    return false
  }
}

export function setBundledExamplesEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(BUNDLED_EXAMPLES_ENABLED_KEY, JSON.stringify(enabled))
  } catch (error) {
    console.warn('Error saving bundled examples setting to localStorage:', error)
  }
}

// The examples retrieval is allowed to draw on: the active folder's, plus
// the bundled corpus when it is switched on. Everything filed elsewhere is
// left out, which is the point of folders — one body of material at a time.
export function getEnabledExamples(): ExampleRecord[] {
  const examples = getUserExamples()
  const active = resolveActiveFolder(listExampleFolders(examples), getStoredActiveFolder())
  const user = examples.filter(example => exampleFolder(example) === active)
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

function createUserExample(
  title: string,
  tags: string[],
  content: string,
  folder: string = UNFILED_FOLDER
): ExampleRecord {
  const filed = normalizeFolderName(folder) || UNFILED_FOLDER
  const example: ExampleRecord = {
    id: `${EXAMPLE_KEY_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    title,
    tags,
    content,
    source: 'user',
    folder: filed === UNFILED_FOLDER ? undefined : filed,
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
// (as folder imports supply) and titles from the file name alone. The file
// is filed under the folder it came from; a file chosen on its own has no
// folder to take, so the caller's fallback (the active folder) applies.
export function importExampleFile(
  filename: string,
  text: string,
  fallbackFolder: string = UNFILED_FOLDER
): ExampleRecord {
  const name = filename.split('/').pop() ?? filename
  const fallbackTitle = name.replace(/\.(md|markdown|txt|text)$/i, '')
  const parsed = parseExampleMarkdown(text, fallbackTitle)
  const fromPath = folderFromImportPath(filename)
  const folder =
    fromPath !== UNFILED_FOLDER ? fromPath : parsed.folder ?? fallbackFolder
  return createUserExample(parsed.title, parsed.tags, parsed.content, folder)
}

// Promotes a completed script's consolidated content to a user example. It
// lands in the active folder, so the script it came from can inform the next
// generation without the user filing it first.
export function promoteScriptToExample(
  title: string,
  content: string,
  tags: string[] = []
): ExampleRecord {
  return createUserExample(title, tags, content, getActiveExampleFolder())
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

// A deleted example's selection history goes with it
function forgetSelectionCounts(ids: string[]): void {
  try {
    const counts = getExampleSelectionCounts()
    const forgotten = ids.filter(id => id in counts)
    if (forgotten.length === 0) return
    for (const id of forgotten) delete counts[id]
    saveExampleSelectionCounts(counts)
  } catch (error) {
    console.warn('Error clearing selection counts for deleted examples:', error)
  }
}

export function deleteUserExample(id: string): void {
  if (!id.startsWith(EXAMPLE_KEY_PREFIX)) return
  window.localStorage.removeItem(id)
  forgetSelectionCounts([id])
}

// Deletes a whole folder — every user example filed under it — and returns
// how many went. Folders exist only as the examples filed under them, so an
// emptied folder simply stops existing.
export function deleteExampleFolder(folder: string): number {
  const target = normalizeFolderName(folder) || UNFILED_FOLDER
  const doomed = getUserExamples().filter(example => exampleFolder(example) === target)
  for (const example of doomed) {
    window.localStorage.removeItem(example.id)
  }
  forgetSelectionCounts(doomed.map(example => example.id))
  return doomed.length
}

export function updateUserExampleTags(id: string, tags: string[]): void {
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (!example) return
  saveUserExample({ ...example, tags })
}

// Files an example under another folder, creating that folder by the act of
// putting something in it. Returns the folder the example ended up in.
export function moveExampleToFolder(id: string, folder: string): string {
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (!example) return UNFILED_FOLDER
  const target = normalizeFolderName(folder) || UNFILED_FOLDER
  saveUserExample({
    ...example,
    folder: target === UNFILED_FOLDER ? undefined : target
  })
  return target
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
