import { describe, it, expect } from 'vitest'
import { describePromotableScript, listPromotableScripts } from '../scriptToExample'
import type { Script } from '../../types/script'
import type { RawConversation } from '../../types/conversation'
import type { ExampleRecord } from '../../types/example'

const script = (id: string, overrides: Partial<Script> = {}): Script => ({
  id,
  title: `Script ${id}`,
  content: '',
  createdAt: '1/1/2026',
  isArchived: false,
  status: 'complete',
  ...overrides
})

const conversation = (scriptId: string, sections: string[]): RawConversation => ({
  id: `conv_${scriptId}`,
  scriptId,
  generations: [
    { messages: [], response: '# Outline\n\n## First\nplan', timestamp: 0 },
    ...sections.map(section => ({
      messages: [],
      response: section,
      timestamp: 0
    }))
  ],
  createdAt: 0,
  updatedAt: 0
})

const example = (overrides: Partial<ExampleRecord> = {}): ExampleRecord => ({
  id: 'example_1',
  title: 'Saved',
  tags: [],
  content: 'text',
  source: 'user',
  ...overrides
})

describe('listPromotableScripts', () => {
  it('offers a script with its consolidated text', () => {
    const promotable = listPromotableScripts(
      [script('script_1000_a')],
      [conversation('script_1000_a', ['## First\nSettle back.'])],
      []
    )

    expect(promotable).toHaveLength(1)
    expect(promotable[0].content).toBe('# Script script_1000_a\n\n## First\nSettle back.')
    expect(promotable[0].wordCount).toBe(7)
  })

  it('leaves out scripts with nothing written, and archived ones', () => {
    const promotable = listPromotableScripts(
      [
        script('script_1000_a'),
        script('script_2000_b', { isArchived: true }),
        script('script_3000_c')
      ],
      [
        conversation('script_1000_a', ['## First\nSettle back.']),
        conversation('script_2000_b', ['## First\nSettle back.']),
        // Nothing but an outline: the script has not been written yet
        conversation('script_3000_c', [])
      ],
      []
    )

    expect(promotable.map(entry => entry.script.id)).toEqual(['script_1000_a'])
  })

  it('marks a script the corpus already holds an example for', () => {
    const promotable = listPromotableScripts(
      [script('script_1000_a')],
      [conversation('script_1000_a', ['## First\nSettle back.'])],
      [example({ sourceScriptId: 'script_1000_a', folder: 'Sleep' })]
    )

    expect(promotable[0].savedExampleId).toBe('example_1')
    expect(promotable[0].savedFolder).toBe('Sleep')
    expect(describePromotableScript(promotable[0])).toContain('already saved')
  })

  it('lists the newest script first', () => {
    const promotable = listPromotableScripts(
      [script('script_1000_a'), script('script_3000_c')],
      [
        conversation('script_1000_a', ['## First\nSettle back.']),
        conversation('script_3000_c', ['## First\nSettle back.'])
      ],
      []
    )

    expect(promotable.map(entry => entry.script.id)).toEqual([
      'script_3000_c',
      'script_1000_a'
    ])
  })
})
