import { describe, it, expect } from 'vitest'
import {
  adoptExampleAsScript,
  buildConversionGenerations,
  convertExampleToScript,
  distinctSectionTitle,
  splitExampleSections,
  stripDocumentTitle,
  OPENING_SECTION_TITLE,
  WHOLE_SCRIPT_SECTION_TITLE
} from '../exampleToScript'
import { consolidateSections, getLatestOutline } from '../conversationDocument'
import type { ExampleRecord } from '../../types/example'
import type { RawConversation } from '../../types/conversation'

const STRUCTURED = [
  '# A Quiet Descent',
  '',
  '## Induction',
  'Settle back and let your eyes close.',
  '',
  '## Deepening',
  'Down and down, each breath heavier than the last.',
  '',
  '## Return',
  'And up, awake, carrying it with you.'
].join('\n')

const example = (overrides: Partial<ExampleRecord> = {}): ExampleRecord => ({
  id: 'example_1',
  title: 'A Quiet Descent',
  tags: ['sleep'],
  content: STRUCTURED,
  source: 'user',
  ...overrides
})

// The conversation the script page would hold for an adopted example
const conversationFrom = (record: ExampleRecord): RawConversation => ({
  id: 'conv_1',
  scriptId: 'script_1',
  generations: adoptExampleAsScript(record, 'script_1', 1_000).generations,
  createdAt: 1_000,
  updatedAt: 1_000
})

describe('stripDocumentTitle', () => {
  it('takes the "# Title" line off the body', () => {
    expect(stripDocumentTitle('# Title\n\nFirst line.')).toBe('First line.')
  })

  it('leaves a body that opens with a section heading alone', () => {
    expect(stripDocumentTitle('## Induction\nFirst line.')).toBe('## Induction\nFirst line.')
  })
})

describe('distinctSectionTitle', () => {
  it('numbers a repeated title rather than letting it collide', () => {
    expect(distinctSectionTitle('Deepening', [])).toBe('Deepening')
    expect(distinctSectionTitle('Deepening', ['Deepening'])).toBe('Deepening (2)')
    expect(distinctSectionTitle('Deepening', ['Deepening', 'Deepening (2)'])).toBe(
      'Deepening (3)'
    )
  })
})

describe('splitExampleSections', () => {
  it('splits at the section headings', () => {
    expect(splitExampleSections(stripDocumentTitle(STRUCTURED)).map(s => s.title)).toEqual([
      'Induction',
      'Deepening',
      'Return'
    ])
  })

  it('keeps prose that sits above the first heading', () => {
    const sections = splitExampleSections('Before anything else.\n\n## Induction\nSettle back.')
    expect(sections[0]).toEqual({
      title: OPENING_SECTION_TITLE,
      content: 'Before anything else.'
    })
    expect(sections).toHaveLength(2)
  })

  it('makes an unstructured script one section rather than none', () => {
    const sections = splitExampleSections('Settle back and let your eyes close.')
    expect(sections).toEqual([
      { title: WHOLE_SCRIPT_SECTION_TITLE, content: 'Settle back and let your eyes close.' }
    ])
  })

  it('does not let two sections of the same name collapse into one', () => {
    const sections = splitExampleSections(
      '## Deepening\nFirst pass.\n\n## Deepening\nSecond pass.'
    )
    expect(sections).toEqual([
      { title: 'Deepening', content: 'First pass.' },
      { title: 'Deepening (2)', content: 'Second pass.' }
    ])
  })
})

describe('convertExampleToScript', () => {
  it('takes the title from the script when it has one', () => {
    expect(convertExampleToScript('deep-rest.md', STRUCTURED).title).toBe('A Quiet Descent')
  })

  it('falls back to the example title', () => {
    expect(convertExampleToScript('Deep Rest', '## Induction\nSettle back.').title).toBe(
      'Deep Rest'
    )
  })

  it('writes an outline the script page can read back', () => {
    const outline = getLatestOutline({
      id: 'c',
      scriptId: 's',
      generations: [{ messages: [], response: convertExampleToScript('x', STRUCTURED).outline, timestamp: 0 }],
      createdAt: 0,
      updatedAt: 0
    })

    expect(outline?.title).toBe('A Quiet Descent')
    expect(outline?.sections.map(section => section.title)).toEqual([
      'Induction',
      'Deepening',
      'Return'
    ])
    // Every section carries a description, so a regeneration has a brief
    expect(outline?.sections.every(section => section.description.length > 0)).toBe(true)
  })

  it('treats the script as having been written for its own spoken length', () => {
    const long = `## Induction\n${'and down you go. '.repeat(1300)}`
    expect(convertExampleToScript('Long', long).targetMinutes).toBeGreaterThan(10)
  })
})

describe('adoptExampleAsScript', () => {
  it('produces a conversation the document consolidates back to the example', () => {
    const sections = consolidateSections(conversationFrom(example()))

    expect(sections).toEqual([
      { title: 'Induction', content: 'Settle back and let your eyes close.' },
      { title: 'Deepening', content: 'Down and down, each breath heavier than the last.' },
      { title: 'Return', content: 'And up, awake, carrying it with you.' }
    ])
  })

  it('loses no words when the example has no headings at all', () => {
    const plain = example({ content: 'Settle back. Let it happen.' })
    const sections = consolidateSections(conversationFrom(plain))

    expect(sections).toEqual([
      { title: WHOLE_SCRIPT_SECTION_TITLE, content: 'Settle back. Let it happen.' }
    ])
  })

  it('records the script as a finished one that came from the corpus', () => {
    const { script } = adoptExampleAsScript(example(), 'script_1', 1_000)

    expect(script).toMatchObject({
      id: 'script_1',
      title: 'A Quiet Descent',
      status: 'complete',
      isArchived: false,
      sourceExampleId: 'example_1',
      tags: ['sleep']
    })
    // Nothing was generated for it, so it claims no provider or model
    expect(script.provider).toBeUndefined()
    expect(script.model).toBeUndefined()
  })

  it('starts with the outline generation, as a generated script does', () => {
    const generations = buildConversionGenerations(
      convertExampleToScript('A Quiet Descent', STRUCTURED),
      'A Quiet Descent',
      1_000
    )

    expect(generations[0].response.startsWith('# A Quiet Descent')).toBe(true)
    expect(generations).toHaveLength(4)
    expect(generations[1].response.startsWith('## Induction')).toBe(true)
  })
})
