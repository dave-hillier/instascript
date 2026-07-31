import { describe, it, expect } from 'vitest'
import {
  buildExampleFs,
  listExampleFsPaths,
  readExampleFsPath,
  renderExampleFsTree
} from '../exampleFs'
import type { ExampleRecord } from '../../types/example'

const example: ExampleRecord = {
  id: 'example_1',
  title: 'A Quiet Descent',
  tags: ['sleep', 'deepening'],
  source: 'user',
  content: [
    '# A Quiet Descent',
    '',
    '## Settling and induction',
    '',
    'Let your eyes close, and notice the weight of your body in the chair.',
    '',
    '## Counting deeper',
    '',
    'Ten, drifting. Nine, heavier. Eight, further away from the room.',
    '',
    '## Coming up',
    '',
    'One, coming back. Two, aware of the room. Three, eyes open.'
  ].join('\n'),
  sections: [
    { title: 'Settling and induction', prompt: 'Brings attention to the body.' },
    { title: 'Counting deeper', prompt: 'Deepens with a descending count.' },
    { title: 'Coming up', prompt: 'Returns to waking on a count of three.' }
  ]
}

describe('buildExampleFs', () => {
  it('mounts each section at a numbered path, in the order it is written', () => {
    const tree = buildExampleFs(example)

    expect(tree.sections.map(section => section.path)).toEqual([
      '/sections/010-settling-and-induction',
      '/sections/020-counting-deeper',
      '/sections/030-coming-up'
    ])
    expect(tree.sections.map(section => section.order)).toEqual([10, 20, 30])
  })

  it('joins each section to the spec stored for it', () => {
    const tree = buildExampleFs(example)

    expect(tree.sections[1].prompt).toBe('Deepens with a descending count.')
    expect(tree.sections[1].wordCount).toBeGreaterThan(0)
  })

  it('projects an example that was never split, leaving the specs empty', () => {
    const tree = buildExampleFs({ ...example, sections: undefined })

    expect(tree.sections).toHaveLength(3)
    expect(tree.sections.every(section => section.prompt === '')).toBe(true)
  })

  it('gives two sections with the same title distinct paths', () => {
    const tree = buildExampleFs({
      ...example,
      content: '## Drift\nFirst body.\n## Drift\nSecond body.',
      sections: undefined
    })

    expect(tree.sections.map(section => section.path)).toEqual([
      '/sections/010-drift',
      '/sections/020-drift-2'
    ])
  })
})

describe('readExampleFsPath', () => {
  const tree = buildExampleFs(example)

  it('lists a file for the example, its metadata and each section', () => {
    expect(listExampleFsPaths(tree)).toEqual([
      '/example.md',
      '/meta.yaml',
      '/sections/010-settling-and-induction/content.md',
      '/sections/010-settling-and-induction/meta.yaml',
      '/sections/010-settling-and-induction/prompt.md',
      '/sections/020-counting-deeper/content.md',
      '/sections/020-counting-deeper/meta.yaml',
      '/sections/020-counting-deeper/prompt.md',
      '/sections/030-coming-up/content.md',
      '/sections/030-coming-up/meta.yaml',
      '/sections/030-coming-up/prompt.md'
    ])
  })

  it('reads a section spec and its body separately', () => {
    expect(readExampleFsPath(tree, '/sections/020-counting-deeper/prompt.md')).toBe(
      'Deepens with a descending count.'
    )
    expect(readExampleFsPath(tree, '/sections/020-counting-deeper/content.md')).toContain(
      'Ten, drifting.'
    )
  })

  it('reads a section meta file', () => {
    const meta = readExampleFsPath(tree, '/sections/030-coming-up/meta.yaml')

    expect(meta).toContain('slug: coming-up')
    expect(meta).toContain('order: 30')
  })

  it('reads the whole example back as markdown', () => {
    const content = readExampleFsPath(tree, '/example.md')

    expect(content).toContain('# A Quiet Descent')
    expect(content).toContain('## Counting deeper')
  })

  it('returns null for a path that is not in the tree', () => {
    expect(readExampleFsPath(tree, '/sections/090-nowhere/content.md')).toBeNull()
    expect(readExampleFsPath(tree, '/sections/010-settling-and-induction/notes.md')).toBeNull()
  })
})

describe('renderExampleFsTree', () => {
  it('renders one line per section with its word count', () => {
    const rendered = renderExampleFsTree(buildExampleFs(example))

    expect(rendered).toContain('# A Quiet Descent')
    expect(rendered).toContain('/sections/')
    expect(rendered).toContain('010-settling-and-induction/')
  })
})
