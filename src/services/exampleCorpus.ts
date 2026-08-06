import YAML from 'yaml'
import type { ExampleRecord } from '../types/example'
import { BUNDLED_EXAMPLE_SCRIPTS } from '../data/bundledExampleScripts'
import { canonicalizeTags } from './standardTags'

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
  sourceScriptId?: string
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
  let sourceScriptId: string | undefined
  let content = raw

  const frontMatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (frontMatterMatch) {
    try {
      const parsed = YAML.parse(frontMatterMatch[1]) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.title === 'string') title = parsed.title
        if (Array.isArray(parsed.tags)) {
          tags = canonicalizeTags(parsed.tags.map(String))
        } else if (typeof parsed.tags === 'string') {
          tags = parseTags(parsed.tags)
        }
        if (typeof parsed.folder === 'string') folder = normalizeFolderName(parsed.folder) || undefined
        if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt
        if (typeof parsed.sourceScriptId === 'string' && parsed.sourceScriptId.trim()) {
          sourceScriptId = parsed.sourceScriptId.trim()
        }
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

  return { title, tags, folder, content: content.trim(), createdAt, embedding, sourceScriptId }
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
  // Only examples saved from a library script carry this, so everything
  // imported from a file round-trips exactly as it did before
  if (example.sourceScriptId) {
    frontMatter.sourceScriptId = example.sourceScriptId
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

// Splits a comma-separated tag string into clean tags. Everything typed or
// imported comes through here, so a standard tag written another way — "nsfw",
// "for her", "post hypnotic" — lands as the standard one (story 8.17).
export function parseTags(value: string): string[] {
  return canonicalizeTags(value.split(','))
}

// --- Folders --------------------------------------------------------------
// User examples are filed into folders, and exactly one folder at a time is
// the one retrieval draws on. Folders come from imports (a folder import
// files its scripts under the folder they came from), from being created
// outright, and from filing an example into one. Examples with no folder —
// everything imported before folders existed — belong to the unfiled folder,
// which is what a fresh install and every upgraded install start on.
//
// The folder lives on the example, so the folders that hold something need
// no separate record. A folder the user has made, though, outlives its
// contents: the names are kept in their own list so that a new folder can be
// made before anything goes in it, and so that emptying a folder does not
// silently discard it. Only deleting a folder takes it off that list.

export const UNFILED_FOLDER = 'Unfiled'
export const ACTIVE_EXAMPLE_FOLDER_KEY = 'activeExampleFolder'
export const EXAMPLE_FOLDERS_KEY = 'exampleFolders'

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

// Pure: every folder there is — the ones holding examples and the ones the
// user made — alphabetically, with the unfiled catch-all last. Unfiled is
// listed only when something is actually unfiled: it is where examples with
// no folder live, not a folder in its own right.
export function listExampleFolders(
  examples: ExampleRecord[],
  declared: string[] = []
): string[] {
  const folders = new Set(examples.map(exampleFolder))
  const named = new Set(declared.map(normalizeFolderName).filter(Boolean))
  for (const folder of folders) {
    if (folder !== UNFILED_FOLDER) named.add(folder)
  }
  const sorted = [...named].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' })
  )
  return folders.has(UNFILED_FOLDER) ? [...sorted, UNFILED_FOLDER] : sorted
}

// Pure: the stored list of folder names the user has made, cleaned of
// anything malformed. The unfiled folder is implicit and never listed.
export function parseFolderList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const names = parsed
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeFolderName)
      .filter(name => name && name !== UNFILED_FOLDER)
    return [...new Set(names)]
  } catch {
    return []
  }
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

export function getDeclaredFolders(): string[] {
  try {
    return parseFolderList(window.localStorage.getItem(EXAMPLE_FOLDERS_KEY))
  } catch (error) {
    console.warn('Error loading example folders from localStorage:', error)
    return []
  }
}

function saveDeclaredFolders(folders: string[]): void {
  try {
    window.localStorage.setItem(EXAMPLE_FOLDERS_KEY, JSON.stringify(folders))
  } catch (error) {
    console.warn('Error saving example folders to localStorage:', error)
  }
}

// Records that a folder exists, so it survives being emptied. Every path
// that files something into a folder goes through here.
function declareFolder(folder: string): void {
  if (folder === UNFILED_FOLDER) return
  const declared = getDeclaredFolders()
  if (declared.includes(folder)) return
  saveDeclaredFolders([...declared, folder])
}

// Creates an empty folder, ready to be filed into or made the active one.
// Returns the name as stored, or '' for a name that is nothing at all.
export function createExampleFolder(name: string): string {
  const folder = normalizeFolderName(name)
  // Unfiled is where examples with no folder already live; it needs no
  // creating, and a folder of that name would be indistinguishable from it
  if (!folder || folder === UNFILED_FOLDER) return ''
  declareFolder(folder)
  return folder
}

// Renames a folder, taking its examples with it. Renaming onto an existing
// name merges the two, and renaming the unfiled folder files everything that
// was loose under the new name. The active folder follows the rename, so
// generation keeps drawing on the same material. Returns the new name.
export function renameExampleFolder(from: string, to: string): string {
  const source = normalizeFolderName(from) || UNFILED_FOLDER
  const target = normalizeFolderName(to)
  if (!target || target === source) return source

  for (const example of getUserExamples()) {
    if (exampleFolder(example) !== source) continue
    saveUserExample({
      ...example,
      folder: target === UNFILED_FOLDER ? undefined : target
    })
  }

  const declared = getDeclaredFolders().filter(folder => folder !== source)
  saveDeclaredFolders(
    target === UNFILED_FOLDER || declared.includes(target)
      ? declared
      : [...declared, target]
  )

  if ((getStoredActiveFolder() ?? UNFILED_FOLDER) === source) {
    setActiveExampleFolder(target)
  }
  return target
}

function getStoredActiveFolder(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_EXAMPLE_FOLDER_KEY)
  } catch (error) {
    console.warn('Error loading the active example folder from localStorage:', error)
    return null
  }
}

// Every folder there is, for listing and for filing an example into one
export function getExampleFolders(): string[] {
  return listExampleFolders(getUserExamples(), getDeclaredFolders())
}

// The folder retrieval draws on, resolved against the folders that exist
export function getActiveExampleFolder(): string {
  return resolveActiveFolder(getExampleFolders(), getStoredActiveFolder())
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
        embedding: parsed.embedding,
        sourceScriptId: parsed.sourceScriptId
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
  const active = resolveActiveFolder(
    listExampleFolders(examples, getDeclaredFolders()),
    getStoredActiveFolder()
  )
  const user = examples.filter(example => exampleFolder(example) === active)
  if (!areBundledExamplesEnabled()) return user
  return [...BUNDLED_EXAMPLE_SCRIPTS, ...user]
}

// Canonicalising here rather than at each call site means every route into
// the corpus — import, promotion from the library, re-tagging, what the
// utility model suggested — stores one spelling of a standard tag. The stored
// record is returned so callers hand back what was written rather than what
// they asked to write.
function saveUserExample(example: ExampleRecord): ExampleRecord {
  const stored: ExampleRecord = { ...example, tags: canonicalizeTags(example.tags) }
  window.localStorage.setItem(stored.id, serializeExampleToMarkdown(stored))
  return stored
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
  folder: string = UNFILED_FOLDER,
  sourceScriptId?: string
): ExampleRecord {
  const filed = normalizeFolderName(folder) || UNFILED_FOLDER
  const example: ExampleRecord = {
    id: `${EXAMPLE_KEY_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    title,
    tags,
    content,
    source: 'user',
    folder: filed === UNFILED_FOLDER ? undefined : filed,
    createdAt: Date.now(),
    sourceScriptId
  }
  const stored = saveUserExample(example)
  declareFolder(filed)
  void attachEmbedding(stored)
  return stored
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

// Where an imported file is filed. `folder` is a destination the user chose,
// which overrides everything; without one the file goes to the folder it came
// from, then to what its own front matter says, then to `fallback` — the
// folder in use, for a file chosen on its own.
export interface ImportDestination {
  folder?: string
  fallback?: string
}

// Pure: the folder a file lands in, given the path it arrived under, any
// folder its front matter carries, and the destination the user chose
export function resolveImportFolder(
  path: string,
  frontMatterFolder: string | undefined,
  destination: ImportDestination = {}
): string {
  const chosen = destination.folder ? normalizeFolderName(destination.folder) : ''
  if (chosen) return chosen
  const fromPath = folderFromImportPath(path)
  if (fromPath !== UNFILED_FOLDER) return fromPath
  if (frontMatterFolder) return normalizeFolderName(frontMatterFolder) || UNFILED_FOLDER
  return normalizeFolderName(destination.fallback ?? '') || UNFILED_FOLDER
}

// Imports a markdown or plain text file as a user example. Accepts a path
// (as folder imports supply) and titles from the file name alone.
export function importExampleFile(
  filename: string,
  text: string,
  destination: ImportDestination = {}
): ExampleRecord {
  const name = filename.split('/').pop() ?? filename
  const fallbackTitle = name.replace(/\.(md|markdown|txt|text)$/i, '')
  const parsed = parseExampleMarkdown(text, fallbackTitle)
  const folder = resolveImportFolder(filename, parsed.folder, destination)
  return createUserExample(parsed.title, parsed.tags, parsed.content, folder)
}

// Saving a library script into the corpus (the other half of opening an
// example as a script). Without a folder it lands in the active one, so the
// script can inform the next generation without being filed first.
export interface ScriptPromotion {
  title: string
  content: string
  tags?: string[]
  folder?: string
  // The script this came from, kept so the corpus can say it already holds
  // this script and so a later save updates that example instead of adding
  // a second copy of it
  scriptId?: string
}

export function promoteScriptToExample({
  title,
  content,
  tags = [],
  folder,
  scriptId
}: ScriptPromotion): ExampleRecord {
  const existing = scriptId ? findExampleForScript(scriptId) : undefined
  if (existing) {
    // The script has moved on since it was saved: the example held for it is
    // brought up to date rather than joined by a stale twin. It keeps the
    // folder it was filed into, which may not be the active one any more.
    const updated: ExampleRecord = {
      ...existing,
      title,
      content,
      tags: tags.length > 0 ? tags : existing.tags
    }
    const stored = saveUserExample(updated)
    if (content !== existing.content) void attachEmbedding(stored)
    return stored
  }
  return createUserExample(
    title,
    tags,
    content,
    folder ?? getActiveExampleFolder(),
    scriptId
  )
}

// The example held for a library script, if the corpus has one
export function findExampleForScript(scriptId: string): ExampleRecord | undefined {
  return getUserExamples().find(example => example.sourceScriptId === scriptId)
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
  // Removing the last example in a folder is not removing the folder, so the
  // folder is recorded before its contents go
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (example) declareFolder(exampleFolder(example))
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
  saveDeclaredFolders(getDeclaredFolders().filter(name => name !== target))
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
  // Both ends are folders the user has: the one being filed into, and the one
  // being left, which stays even if this was the last example in it
  declareFolder(exampleFolder(example))
  declareFolder(target)
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
  const stored = saveUserExample(updated)

  if (enhancement.content && enhancement.content !== example.content) {
    void attachEmbedding(stored)
  }

  return stored
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
