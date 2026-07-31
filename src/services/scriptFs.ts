// Imported raw rather than through prompts.ts, which imports this module.
import outlineGenerationTemplate from '../prompts/outline-generation.txt?raw'
import type { Generation, RawConversation } from '../types/conversation'
import type { DocumentSection } from './conversationDocument'
import { consolidateSections, getLatestOutline, isOutlineResponse, parseMarkdownSections, parseOutline } from './conversationDocument'
import { countWords } from '../utils/scriptMetrics'

// A read-only virtual filesystem projected over a raw conversation. The latest
// outline is the mount table — it decides which sections exist and in what
// order — while the consolidated generations supply the bodies. Nothing here
// mutates or reinterprets the conversation: it is a second, addressable view of
// the same fold, shaped so a model can be told "here is the tree" and then ask
// for one path at a time.

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

export interface ScriptFsTree {
  title: string
  brief: string
  sections: ScriptFsSection[]
  // Sections that exist in the fold but not in the latest outline. Surfaced
  // rather than dropped so a re-outline never silently loses written prose.
  unmounted: DocumentSection[]
}

const SECTIONS_ROOT = '/sections/'

// Gap numbering (010, 020, 030) leaves room to insert a section between two
// others without renumbering every path after it.
function orderPrefix(index: number): string {
  return String((index + 1) * 10).padStart(3, '0')
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

// Two outline entries can share a title (or slugify to the same thing); the
// path has to stay unique, so later collisions gain a numeric suffix.
function uniqueSlugs(titles: string[]): string[] {
  const taken = new Set<string>()
  return titles.map(title => {
    const base = slugify(title)
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

export function buildScriptFs(conversation: RawConversation): ScriptFsTree {
  const outline = getLatestOutline(conversation)
  const consolidated = consolidateSections(conversation)
  const contentByTitle = new Map(consolidated.map(section => [section.title, section.content]))
  const snapshots = outlineSnapshots(conversation)
  const bodies = bodyRecords(conversation.generations)

  const outlineSections = outline?.sections ?? []
  const slugs = uniqueSlugs(outlineSections.map(section => section.title))

  const sections: ScriptFsSection[] = outlineSections.map((section, index) => {
    const content = contentByTitle.get(section.title) ?? ''
    const body = bodies.get(section.title)
    const specifiedAt = specifiedAtFor(snapshots, section.title, section.description)
    const generatedAt = body?.timestamp
    const stale = content === '' || (specifiedAt !== undefined && generatedAt !== undefined && specifiedAt > generatedAt)
    return {
      title: section.title,
      slug: slugs[index],
      path: `${SECTIONS_ROOT}${orderPrefix(index)}-${slugs[index]}`,
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
    unmounted
  }
}

export function listScriptFsPaths(tree: ScriptFsTree): string[] {
  const paths = ['/brief.md', '/script.md']
  for (const section of tree.sections) {
    paths.push(`${section.path}/prompt.md`, `${section.path}/content.md`, `${section.path}/meta.yaml`)
  }
  return paths.sort()
}

function buildScriptMarkdown(tree: ScriptFsTree): string {
  const blocks = tree.sections
    .filter(section => section.content !== '')
    .map(section => `## ${section.title}\n${section.content}`)
  return [tree.title ? `# ${tree.title}` : '', ...blocks].filter(Boolean).join('\n\n')
}

function renderMeta(section: ScriptFsSection): string {
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
  if (section.exampleIds !== undefined) lines.push(`exampleIds: [${section.exampleIds.join(', ')}]`)
  return `${lines.join('\n')}\n`
}

// Accepts the section directory itself, with or without a trailing slash, or
// any file beneath it, so callers can address a section however they hold it.
export function resolveSectionPath(tree: ScriptFsTree, path: string): ScriptFsSection | null {
  const normalised = path.replace(/\/+$/, '')
  return tree.sections.find(section => normalised === section.path || normalised.startsWith(`${section.path}/`)) ?? null
}

export function readScriptFsPath(tree: ScriptFsTree, path: string): string | null {
  if (path === '/brief.md') return tree.brief
  if (path === '/script.md') return buildScriptMarkdown(tree)

  const section = resolveSectionPath(tree, path)
  if (!section) return null

  const file = path.slice(section.path.length + 1)
  if (file === 'prompt.md') return section.prompt
  if (file === 'content.md') return section.content
  if (file === 'meta.yaml') return renderMeta(section)
  return null
}

function statusOf(section: ScriptFsSection): string {
  if (section.content === '') return 'empty'
  return section.stale ? 'stale' : 'fresh'
}

// A compact projection meant for prompts: one line per section, aligned so the
// word counts and statuses read as columns.
export function renderScriptFsTree(tree: ScriptFsTree): string {
  const names = tree.sections.map(section => `${section.path.slice(SECTIONS_ROOT.length)}/`)
  const nameWidth = names.reduce((widest, name) => Math.max(widest, name.length), 0) + 3

  const lines = [`# ${tree.title}`, SECTIONS_ROOT]
  tree.sections.forEach((section, index) => {
    const count = String(section.wordCount).padStart(6)
    lines.push(`  ${names[index].padEnd(nameWidth)}${count}w  ${statusOf(section)}`)
  })

  if (tree.unmounted.length > 0) {
    const label = tree.unmounted.length === 1 ? 'section' : 'sections'
    const titles = tree.unmounted.map(section => `"${section.title}"`).join(', ')
    lines.push(`(${tree.unmounted.length} ${label} not in the outline: ${titles})`)
  }

  return `${lines.join('\n')}\n`
}
