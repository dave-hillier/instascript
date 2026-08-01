import YAML from 'yaml'
import type { ExampleRecord, ExampleGroupSummary } from '../types/example'
import { BUNDLED_EXAMPLE_SCRIPTS, BUNDLED_GROUP } from '../data/bundledExampleScripts'

// User-imported examples live in localStorage under example_* keys as YAML
// front matter + markdown, matching the script storage format. Bundled and
// user examples are merged at search time.

export const EXAMPLE_KEY_PREFIX = 'example_'

// Where an example lands when nothing names a group for it: a single file
// imported without a group, or a stored example predating groups
export const UNGROUPED = 'Ungrouped'

export { BUNDLED_GROUP }

interface ParsedExampleFile {
  title: string
  tags: string[]
  group?: string
  content: string
  createdAt?: number
  embedding?: number[]
}

// Parses a markdown example file: optional YAML front matter (title, tags,
// group), then the script body. Falls back to the first "# Title" heading,
// then to the supplied fallback (typically the filename without extension).
export function parseExampleMarkdown(raw: string, fallbackTitle: string): ParsedExampleFile {
  let title: string | undefined
  let tags: string[] = []
  let group: string | undefined
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
        if (typeof parsed.group === 'string' && parsed.group.trim()) {
          group = parsed.group.trim()
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

  return { title, tags, group, content: content.trim(), createdAt, embedding }
}

export function serializeExampleToMarkdown(example: ExampleRecord): string {
  const frontMatter: Record<string, unknown> = {
    title: example.title,
    tags: example.tags,
    group: example.group,
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

// Pure: a group name as it is stored. Case and surrounding space are kept as
// typed — group names are shown to the reader — but a blank one is not a
// group, so it becomes the ungrouped bucket.
export function normalizeGroupName(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  return trimmed || UNGROUPED
}

// Pure: the group an imported file belongs to, from the path a folder import
// supplies ("Long form/sleep/deep-rest.md" → "sleep", so subfolders are their
// own groups). A bare filename has no folder to name it, so the group the
// import form asked for is used instead.
export function groupFromImportPath(path: string, fallback: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return normalizeGroupName(fallback)
  return normalizeGroupName(segments[segments.length - 2])
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
        // Examples stored before groups existed have no group key; they read
        // back as ungrouped rather than needing a rewrite migration
        group: normalizeGroupName(parsed.group),
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

// --- Group enablement ----------------------------------------------------
// A group is on or off as a unit, and retrieval only draws on the examples in
// enabled groups — that is how the style is controlled: switch a folder of
// long-form scripts on and the short ones off, and generation imitates the
// former. Disabled groups stay listed (and stay available for id lookups),
// they are just excluded from retrieval.
//
// Stored as the list of *disabled* groups, so a newly imported folder is on
// by default without having to be registered anywhere first.

export const DISABLED_GROUPS_KEY = 'disabledExampleGroups'

// Superseded by DISABLED_GROUPS_KEY; still read once to carry an existing
// opt-in across (the bundled group started out as the only toggle)
export const BUNDLED_EXAMPLES_ENABLED_KEY = 'bundledExamplesEnabled'

// Pure: the stored disabled-group list, ignoring anything malformed
export function parseDisabledGroups(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((name): name is string => typeof name === 'string' && name.length > 0))]
  } catch {
    return []
  }
}

// Pure: what the disabled list should be for a browser that has never stored
// one. The bundled placeholders were opt-in before groups existed, so they
// stay off unless that opt-in was already given.
export function migrateDisabledGroups(bundledEnabledRaw: string | null): string[] {
  const bundledEnabled = bundledEnabledRaw
    ? (() => {
        try {
          return JSON.parse(bundledEnabledRaw) === true
        } catch {
          return false
        }
      })()
    : false
  return bundledEnabled ? [] : [BUNDLED_GROUP]
}

export function getDisabledGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(DISABLED_GROUPS_KEY)
    if (raw !== null) return parseDisabledGroups(raw)

    const migrated = migrateDisabledGroups(
      window.localStorage.getItem(BUNDLED_EXAMPLES_ENABLED_KEY)
    )
    window.localStorage.setItem(DISABLED_GROUPS_KEY, JSON.stringify(migrated))
    return migrated
  } catch (error) {
    console.warn('Error loading example group settings from localStorage:', error)
    return [BUNDLED_GROUP]
  }
}

export function isGroupEnabled(group: string): boolean {
  return !getDisabledGroups().includes(group)
}

export function setGroupEnabled(group: string, enabled: boolean): void {
  try {
    const disabled = new Set(getDisabledGroups())
    if (enabled) {
      disabled.delete(group)
    } else {
      disabled.add(group)
    }
    window.localStorage.setItem(DISABLED_GROUPS_KEY, JSON.stringify([...disabled]))
  } catch (error) {
    console.warn('Error saving example group settings to localStorage:', error)
  }
}

// Pure: the groups present across the corpus, in the order examples list them
// (bundled first, then user examples oldest first), with their sizes
export function summarizeGroups(
  examples: ExampleRecord[],
  disabledGroups: string[]
): ExampleGroupSummary[] {
  const disabled = new Set(disabledGroups)
  const summaries = new Map<string, ExampleGroupSummary>()

  for (const example of examples) {
    const existing = summaries.get(example.group)
    if (existing) {
      existing.count += 1
      // A group holding any user example can be edited; only a wholly bundled
      // one is read-only
      if (example.source === 'user') existing.readOnly = false
      continue
    }
    summaries.set(example.group, {
      name: example.group,
      count: 1,
      enabled: !disabled.has(example.group),
      readOnly: example.source === 'bundled'
    })
  }

  return [...summaries.values()]
}

// The examples retrieval is allowed to draw on
export function getEnabledExamples(): ExampleRecord[] {
  const disabled = new Set(getDisabledGroups())
  return getAllExamples().filter(example => !disabled.has(example.group))
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
  group: string,
  content: string
): ExampleRecord {
  const example: ExampleRecord = {
    id: `${EXAMPLE_KEY_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    title,
    tags,
    group: normalizeGroupName(group),
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

// Imports a markdown or plain text file as a user example. Accepts a path (as
// folder imports supply) and titles from the file name alone. The group comes
// from the file's own front matter if it names one — an explicit label beats
// an inferred one — otherwise from the folder the file sits in, falling back
// to the group the import form asked for.
export function importExampleFile(
  filename: string,
  text: string,
  fallbackGroup: string = UNGROUPED
): ExampleRecord {
  const name = filename.split('/').pop() ?? filename
  const fallbackTitle = name.replace(/\.(md|markdown|txt|text)$/i, '')
  const parsed = parseExampleMarkdown(text, fallbackTitle)
  const group = parsed.group ?? groupFromImportPath(filename, fallbackGroup)
  return createUserExample(parsed.title, parsed.tags, group, parsed.content)
}

// Promotes a completed script's consolidated content to a user example
export function promoteScriptToExample(
  title: string,
  content: string,
  tags: string[] = [],
  group: string = UNGROUPED
): ExampleRecord {
  return createUserExample(title, tags, group, content)
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

// Moves one example to another group. A group that ends up holding nothing
// simply stops existing — groups are derived from their members, not
// registered separately.
export function updateUserExampleGroup(id: string, group: string): void {
  const example = getUserExamples().find(candidate => candidate.id === id)
  if (!example) return
  saveUserExample({ ...example, group: normalizeGroupName(group) })
}

// Renames a group across every user example in it, carrying its enabled or
// disabled state over so a rename never silently switches the group back on
export function renameExampleGroup(from: string, to: string): void {
  const target = normalizeGroupName(to)
  if (target === from) return

  for (const example of getUserExamples()) {
    if (example.group !== from) continue
    saveUserExample({ ...example, group: target })
  }

  if (!isGroupEnabled(from)) {
    setGroupEnabled(from, true)
    setGroupEnabled(target, false)
  }
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
