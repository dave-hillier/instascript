// Imported raw rather than through prompts.ts, which imports this module.
import outlineGenerationTemplate from '../prompts/outline-generation.txt?raw'
import type { Generation, RawConversation } from '../types/conversation'
import type { DocumentSection } from './conversationDocument'
import { consolidateSections, getLatestOutline, isOutlineResponse, parseMarkdownSections, parseOutline } from './conversationDocument'
import type { ExampleScript } from './exampleSearchService'
import { countWords } from '../utils/scriptMetrics'

// A read-only virtual filesystem projected over a raw conversation. The latest
// outline is the mount table — it decides which sections exist and in what
// order — while the consolidated generations supply the bodies. Nothing here
// mutates or reinterprets the conversation: it is a second, addressable view of
// the same fold, shaped so a model can be told "here is the tree" and then ask
// for one path at a time.
//
// The run's retrieved exemplars mount alongside the script under /examples/.
// They are already in the request — the system prompt carries their full text —
// so mounting them adds no tokens beyond the listing; what it adds is a name.
// A section's meta.yaml can then say which examples informed it by path, and an
// instruction can name one, instead of both pointing at opaque corpus ids.

export interface ScriptFsSection {
  title: string
  slug: string
  path: string
  order: number
  // The outline description: this section's spec, i.e. what it is meant to do
  prompt: string
  content: string
  wordCount: number
  // Build-graph signal: the spec has moved on since the body was written
  stale: boolean
  generatedAt?: number
  specifiedAt?: number
  exampleIds?: string[]
}

// One retrieved exemplar, mounted read-only. Ranked order is the mount order:
// /examples/010- is the most relevant example the retrieval returned.
export interface ScriptFsExample {
  // The corpus id, which is what a generation records in exampleIds. Empty
  // when retrieval returned an example without one.
  id: string
  title: string
  slug: string
  path: string
  order: number
  rank: number
  tags: string[]
  source?: string
  content: string
  wordCount: number
  score?: number
}

export interface ScriptFsTree {
  title: string
  brief: string
  sections: ScriptFsSection[]
  // Sections that exist in the fold but not in the latest outline. Surfaced
  // rather than dropped so a re-outline never silently loses written prose.
  unmounted: DocumentSection[]
  // The exemplars retrieved for this request. Empty when the corpus is off or
  // retrieval failed — an ungrounded run is an ordinary state.
  examples: ScriptFsExample[]
}

export const SECTIONS_ROOT = '/sections/'
const EXAMPLES_ROOT = '/examples/'

// Gap numbering (010, 020, 030) leaves room to insert a section between two
// others without renumbering every path after it.
export function sectionOrderPrefix(index: number): string {
  return String((index + 1) * 10).padStart(3, '0')
}

export function slugifySectionTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

// Two outline entries can share a title (or slugify to the same thing); the
// path has to stay unique, so later collisions gain a numeric suffix.
export function uniqueSectionSlugs(titles: string[]): string[] {
  const taken = new Set<string>()
  return titles.map(title => {
    const base = slugifySectionTitle(title)
    let candidate = base
    let suffix = 1
    // A generated suffix can itself collide with a title that slugifies to it
    // naturally ("Drift", "Drift 2", "Drift!"), so keep counting until the
    // candidate is genuinely free.
    while (taken.has(candidate)) {
      suffix += 1
      candidate = `${base}-${suffix}`
    }
    taken.add(candidate)
    return candidate
  })
}

// Only `content` is guaranteed on an ExampleScript. Retrieval names an example
// by title, with `filename` kept as the legacy alias debugTranscript also
// honours and `id` as the last identifier before it goes unlabelled — a
// fabricated name is worse than none. Shared with prompt formatting so an
// example is called the same thing in the corpus block and in the tree.
export function exampleLabel(example: ExampleScript): string {
  const name = example.metadata?.title ?? example.metadata?.filename ?? example.metadata?.id
  if (name === undefined) return ''
  return String(name).replace(/\s+/g, ' ').trim()
}

function exampleTags(example: ExampleScript): string[] {
  const tags = example.metadata?.tags
  if (typeof tags !== 'string') return []
  return tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
}

function optionalString(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}

// Mounts the retrieved exemplars, index-aligned with the array passed in, so a
// caller that also formats them for the prompt can label each one with the path
// it is mounted at.
export function mountExamples(examples: ExampleScript[]): ScriptFsExample[] {
  const slugs = uniqueSectionSlugs(examples.map(example => exampleLabel(example) || 'example'))

  return examples.map((example, index) => ({
    id: optionalString(example.metadata?.id) ?? optionalString(example.metadata?.filename) ?? '',
    title: exampleLabel(example),
    slug: slugs[index],
    path: `${EXAMPLES_ROOT}${sectionOrderPrefix(index)}-${slugs[index]}`,
    order: (index + 1) * 10,
    rank: index + 1,
    tags: exampleTags(example),
    source: optionalString(example.metadata?.source),
    content: example.content,
    wordCount: countWords(example.content),
    score: typeof example.score === 'number' && Number.isFinite(example.score) ? example.score : undefined
  }))
}

interface OutlineSnapshot {
  timestamp: number
  entries: Map<string, string>
}

function outlineSnapshots(conversation: RawConversation): OutlineSnapshot[] {
  const snapshots: OutlineSnapshot[] = []
  for (const generation of conversation.generations) {
    const parsed = parseOutline(generation.response)
    if (!parsed) continue
    snapshots.push({
      timestamp: generation.timestamp,
      entries: new Map(parsed.sections.map(section => [section.title, section.description]))
    })
  }
  return snapshots
}

// When was this entry last *specified*? Walk the outline history backwards
// while the (title, description) pair is unchanged; the earliest outline it has
// held continuously through is the moment the spec settled. Comparing that with
// generatedAt is what makes staleness a build-graph question rather than a
// guess.
function specifiedAtFor(snapshots: OutlineSnapshot[], title: string, description: string): number | undefined {
  if (snapshots.length === 0) return undefined
  let index = snapshots.length - 1
  while (index > 0) {
    const previous = snapshots[index - 1].entries
    if (!previous.has(title) || previous.get(title) !== description) break
    index--
  }
  return snapshots[index].timestamp
}

interface BodyRecord {
  timestamp: number
  exampleIds?: string[]
}

// Which generation last wrote each section's body. Mirrors consolidateSections'
// rule (outline-shaped responses contribute nothing, later bodies win) so the
// timestamps always describe the content consolidateSections returns.
function bodyRecords(generations: Generation[]): Map<string, BodyRecord> {
  const records = new Map<string, BodyRecord>()
  for (const generation of generations) {
    if (isOutlineResponse(generation.response)) continue
    for (const section of parseMarkdownSections(generation.response)) {
      records.set(section.title, { timestamp: generation.timestamp, exampleIds: generation.exampleIds })
    }
  }
  return records
}

// The first generation's user turn is the brief with the outline-generation
// template appended, because the model needs both in one turn. The template
// has to come back off: its opening line carries no placeholders, which makes
// it a stable cut point, and everything from there on is instruction rather
// than anything the user asked for.
const OUTLINE_TEMPLATE_MARKER = outlineGenerationTemplate.split('\n')[0].trim()

function stripOutlineTemplate(message: string): string {
  if (OUTLINE_TEMPLATE_MARKER === '') return message
  const index = message.indexOf(OUTLINE_TEMPLATE_MARKER)
  return index === -1 ? message : message.slice(0, index).trimEnd()
}

// The brief is the first user turn of the first generation. Later generations
// carry rendered prompt templates, not what the user actually asked for.
function extractBrief(conversation: RawConversation): string {
  const first = conversation.generations[0]
  const message = first?.messages.find(message => message.role === 'user')?.content ?? ''
  return stripOutlineTemplate(message)
}

export function buildScriptFs(
  conversation: RawConversation,
  examples: ExampleScript[] = []
): ScriptFsTree {
  const outline = getLatestOutline(conversation)
  const consolidated = consolidateSections(conversation)
  const contentByTitle = new Map(consolidated.map(section => [section.title, section.content]))
  const snapshots = outlineSnapshots(conversation)
  const bodies = bodyRecords(conversation.generations)

  const outlineSections = outline?.sections ?? []
  const slugs = uniqueSectionSlugs(outlineSections.map(section => section.title))

  const sections: ScriptFsSection[] = outlineSections.map((section, index) => {
    const content = contentByTitle.get(section.title) ?? ''
    const body = bodies.get(section.title)
    const specifiedAt = specifiedAtFor(snapshots, section.title, section.description)
    const generatedAt = body?.timestamp
    const stale = content === '' || (specifiedAt !== undefined && generatedAt !== undefined && specifiedAt > generatedAt)
    return {
      title: section.title,
      slug: slugs[index],
      path: `${SECTIONS_ROOT}${sectionOrderPrefix(index)}-${slugs[index]}`,
      order: (index + 1) * 10,
      prompt: section.description,
      content,
      wordCount: countWords(content),
      stale,
      generatedAt,
      specifiedAt,
      exampleIds: body?.exampleIds
    }
  })

  const mountedTitles = new Set(outlineSections.map(section => section.title))
  const unmounted = consolidated.filter(section => !mountedTitles.has(section.title))

  return {
    title: outline?.title ?? '',
    brief: extractBrief(conversation),
    sections,
    unmounted,
    examples: mountExamples(examples)
  }
}

export function listScriptFsPaths(tree: ScriptFsTree): string[] {
  const paths = ['/brief.md', '/script.md']
  for (const section of tree.sections) {
    paths.push(`${section.path}/prompt.md`, `${section.path}/content.md`, `${section.path}/meta.yaml`)
  }
  for (const example of tree.examples) {
    paths.push(`${example.path}/content.md`, `${example.path}/meta.yaml`)
  }
  return paths.sort()
}

function buildScriptMarkdown(tree: ScriptFsTree): string {
  const blocks = tree.sections
    .filter(section => section.content !== '')
    .map(section => `## ${section.title}\n${section.content}`)
  return [tree.title ? `# ${tree.title}` : '', ...blocks].filter(Boolean).join('\n\n')
}

// The exemplars that informed a section, named by the path they are mounted at
// so the reference resolves inside the same filesystem. An id retrieval did not
// return this time — a section written in an earlier run, against a different
// selection — has no path to give, so it stays an id rather than disappearing.
function renderInformingExamples(section: ScriptFsSection, tree: ScriptFsTree): string {
  const pathById = new Map(tree.examples.filter(example => example.id !== '').map(example => [example.id, example.path]))
  const names = section.exampleIds!.map(id => pathById.get(id) ?? id)
  return `examples: [${names.join(', ')}]`
}

function renderMeta(section: ScriptFsSection, tree: ScriptFsTree): string {
  const lines = [
    `title: ${section.title}`,
    `slug: ${section.slug}`,
    `path: ${section.path}`,
    `order: ${section.order}`,
    `wordCount: ${section.wordCount}`,
    `stale: ${section.stale}`
  ]
  if (section.generatedAt !== undefined) lines.push(`generatedAt: ${section.generatedAt}`)
  if (section.specifiedAt !== undefined) lines.push(`specifiedAt: ${section.specifiedAt}`)
  if (section.exampleIds !== undefined) lines.push(renderInformingExamples(section, tree))
  return `${lines.join('\n')}\n`
}

function renderExampleMeta(example: ScriptFsExample): string {
  const lines = [
    `title: ${example.title}`,
    `slug: ${example.slug}`,
    `path: ${example.path}`,
    `rank: ${example.rank}`,
    `wordCount: ${example.wordCount}`
  ]
  if (example.id !== '') lines.push(`id: ${example.id}`)
  if (example.source !== undefined) lines.push(`source: ${example.source}`)
  if (example.tags.length > 0) lines.push(`tags: [${example.tags.join(', ')}]`)
  // Retrieval scores are fused reciprocal ranks, not probabilities: four
  // decimals is enough to order them and short enough to read.
  if (example.score !== undefined) lines.push(`score: ${example.score.toFixed(4)}`)
  return `${lines.join('\n')}\n`
}

// Accepts the section directory itself, with or without a trailing slash, or
// any file beneath it, so callers can address a section however they hold it.
export function resolveSectionPath(tree: ScriptFsTree, path: string): ScriptFsSection | null {
  const normalised = path.replace(/\/+$/, '')
  return tree.sections.find(section => normalised === section.path || normalised.startsWith(`${section.path}/`)) ?? null
}

// The same addressing rule as resolveSectionPath, over the mounted exemplars.
export function resolveExamplePath(tree: ScriptFsTree, path: string): ScriptFsExample | null {
  const normalised = path.replace(/\/+$/, '')
  return tree.examples.find(example => normalised === example.path || normalised.startsWith(`${example.path}/`)) ?? null
}

export function readScriptFsPath(tree: ScriptFsTree, path: string): string | null {
  if (path === '/brief.md') return tree.brief
  if (path === '/script.md') return buildScriptMarkdown(tree)

  const example = resolveExamplePath(tree, path)
  if (example) {
    const file = path.slice(example.path.length + 1)
    if (file === 'content.md') return example.content
    if (file === 'meta.yaml') return renderExampleMeta(example)
    return null
  }

  const section = resolveSectionPath(tree, path)
  if (!section) return null

  const file = path.slice(section.path.length + 1)
  if (file === 'prompt.md') return section.prompt
  if (file === 'content.md') return section.content
  if (file === 'meta.yaml') return renderMeta(section, tree)
  return null
}

function statusOf(section: ScriptFsSection): string {
  if (section.content === '') return 'empty'
  return section.stale ? 'stale' : 'fresh'
}

// A compact projection meant for prompts: one line per section, aligned so the
// word counts and statuses read as columns.
export function renderScriptFsTree(tree: ScriptFsTree): string {
  const sectionNames = tree.sections.map(section => `${section.path.slice(SECTIONS_ROOT.length)}/`)
  const exampleNames = tree.examples.map(example => `${example.path.slice(EXAMPLES_ROOT.length)}/`)
  // One width across both roots, so the whole tree reads as a single set of
  // columns rather than two tables that happen to sit under each other.
  const nameWidth = [...sectionNames, ...exampleNames]
    .reduce((widest, name) => Math.max(widest, name.length), 0) + 3

  const entry = (name: string, wordCount: number, trailer: string) =>
    `  ${name.padEnd(nameWidth)}${String(wordCount).padStart(6)}w  ${trailer}`.trimEnd()

  const lines = [`# ${tree.title}`, SECTIONS_ROOT]
  tree.sections.forEach((section, index) => {
    lines.push(entry(sectionNames[index], section.wordCount, statusOf(section)))
  })

  if (tree.unmounted.length > 0) {
    const label = tree.unmounted.length === 1 ? 'section' : 'sections'
    const titles = tree.unmounted.map(section => `"${section.title}"`).join(', ')
    lines.push(`(${tree.unmounted.length} ${label} not in the outline: ${titles})`)
  }

  if (tree.examples.length > 0) {
    lines.push(EXAMPLES_ROOT)
    tree.examples.forEach((example, index) => {
      lines.push(entry(exampleNames[index], example.wordCount, example.tags.join(', ')))
    })
  }

  return `${lines.join('\n')}\n`
}
