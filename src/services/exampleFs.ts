// A read-only virtual filesystem projected over an example, the counterpart of
// scriptFs. Where a script's mount table is its latest outline, an example's is
// the section specs stored when it was split out of a transcript; the markdown
// body supplies the content. Same paths, same file names, same derivation of
// slug, order and word count — so an example and a script in progress are
// addressable the same way.
//
// Nothing here mutates the example. An example with no stored specs still
// projects: its `## ` headings mount as sections with an empty spec, which is
// what an imported script that was never split looks like.

import type { ExampleRecord } from '../types/example'
import { parseMarkdownSections } from './conversationDocument'
import { SECTIONS_ROOT, sectionOrderPrefix, uniqueSectionSlugs } from './scriptFs'
import { countWords } from '../utils/scriptMetrics'

export interface ExampleFsSection {
  title: string
  slug: string
  path: string
  order: number
  // What this stage of the session is for, from the split
  prompt: string
  content: string
  wordCount: number
}

export interface ExampleFsTree {
  id: string
  title: string
  tags: string[]
  sections: ExampleFsSection[]
  wordCount: number
}

export function buildExampleFs(example: ExampleRecord): ExampleFsTree {
  const parsed = parseMarkdownSections(example.content)
  const specs = new Map((example.sections ?? []).map(spec => [spec.title, spec.prompt]))
  const slugs = uniqueSectionSlugs(parsed.map(section => section.title))

  const sections = parsed.map((section, index) => ({
    title: section.title,
    slug: slugs[index],
    path: `${SECTIONS_ROOT}${sectionOrderPrefix(index)}-${slugs[index]}`,
    order: (index + 1) * 10,
    prompt: specs.get(section.title) ?? '',
    content: section.content,
    wordCount: countWords(section.content)
  }))

  return {
    id: example.id,
    title: example.title,
    tags: example.tags,
    sections,
    wordCount: countWords(example.content)
  }
}

export function listExampleFsPaths(tree: ExampleFsTree): string[] {
  const paths = ['/example.md', '/meta.yaml']
  for (const section of tree.sections) {
    paths.push(`${section.path}/prompt.md`, `${section.path}/content.md`, `${section.path}/meta.yaml`)
  }
  return paths.sort()
}

function renderExampleMeta(tree: ExampleFsTree): string {
  return [
    `id: ${tree.id}`,
    `title: ${tree.title}`,
    `tags: [${tree.tags.join(', ')}]`,
    `sections: ${tree.sections.length}`,
    `wordCount: ${tree.wordCount}`
  ].join('\n') + '\n'
}

function renderSectionMeta(section: ExampleFsSection): string {
  return [
    `title: ${section.title}`,
    `slug: ${section.slug}`,
    `path: ${section.path}`,
    `order: ${section.order}`,
    `wordCount: ${section.wordCount}`
  ].join('\n') + '\n'
}

function buildExampleMarkdown(tree: ExampleFsTree): string {
  const blocks = tree.sections
    .filter(section => section.content !== '')
    .map(section => `## ${section.title}\n\n${section.content}`)
  return [tree.title ? `# ${tree.title}` : '', ...blocks].filter(Boolean).join('\n\n')
}

// Accepts the section directory itself, with or without a trailing slash, or
// any file beneath it
export function resolveExampleSectionPath(tree: ExampleFsTree, path: string): ExampleFsSection | null {
  const normalised = path.replace(/\/+$/, '')
  return tree.sections.find(
    section => normalised === section.path || normalised.startsWith(`${section.path}/`)
  ) ?? null
}

export function readExampleFsPath(tree: ExampleFsTree, path: string): string | null {
  if (path === '/example.md') return buildExampleMarkdown(tree)
  if (path === '/meta.yaml') return renderExampleMeta(tree)

  const section = resolveExampleSectionPath(tree, path)
  if (!section) return null

  const file = path.slice(section.path.length + 1)
  if (file === 'prompt.md') return section.prompt
  if (file === 'content.md') return section.content
  if (file === 'meta.yaml') return renderSectionMeta(section)
  return null
}

// One line per section, aligned so the word counts read as a column. Meant for
// display and for prompts, the same as the script tree.
export function renderExampleFsTree(tree: ExampleFsTree): string {
  const names = tree.sections.map(section => `${section.path.slice(SECTIONS_ROOT.length)}/`)
  const nameWidth = names.reduce((widest, name) => Math.max(widest, name.length), 0) + 3

  const lines = [`# ${tree.title}`, SECTIONS_ROOT]
  tree.sections.forEach((section, index) => {
    const count = String(section.wordCount).padStart(6)
    lines.push(`  ${names[index].padEnd(nameWidth)}${count}w`)
  })

  return `${lines.join('\n')}\n`
}
