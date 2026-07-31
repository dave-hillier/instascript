import { describe, it, expect } from 'vitest'
import { buildThread } from '../conversationThread'
import { getScriptRefinementPrompt, buildSectionRegenerationPrompt } from '../prompts'
import type { RawConversation, Generation } from '../../types/conversation'

const generation = (prompt: string, response: string): Generation => ({
  messages: [
    { role: 'system', content: 'style rules' },
    { role: 'user', content: prompt }
  ],
  response,
  timestamp: 0
})

const conversationOf = (generations: Generation[]): RawConversation => ({
  id: 'conversation-1',
  scriptId: 'script-1',
  generations,
  createdAt: 0,
  updatedAt: 0
})

describe('buildThread', () => {
  it('opens with the brief and its chips', () => {
    const entries = buildThread({ brief: 'A calm sleep script', chips: ['12 min', 'sleep'] })

    expect(entries).toEqual([
      { id: 'brief', kind: 'user', text: 'A calm sleep script', chips: ['12 min', 'sleep'] }
    ])
  })

  it('summarises the outline generation by planned sections', () => {
    const entries = buildThread({
      conversation: conversationOf([
        generation('Plan the script.', '# Deep Rest\n\n## Induction\nSettle in\n\n## Deepening\nGo further')
      ])
    })

    expect(entries).toEqual([
      { id: 'gen-0', kind: 'activity', label: 'Planned the outline', detail: '2 sections' }
    ])
  })

  it('reports each written section with its word count', () => {
    const entries = buildThread({
      conversation: conversationOf([
        generation('Now write the "Induction" section of the script.', 'one two three')
      ])
    })

    expect(entries).toEqual([
      { id: 'gen-0', kind: 'activity', label: 'Wrote "Induction"', detail: '3 words' }
    ])
  })

  it('recovers the user instruction from a refinement prompt', () => {
    const entries = buildThread({
      conversation: conversationOf([
        generation(
          getScriptRefinementPrompt('make the induction slower'),
          '## Induction\nSlower now'
        )
      ])
    })

    expect(entries).toEqual([
      { id: 'gen-0-instruction', kind: 'user', text: 'make the induction slower' },
      { id: 'gen-0', kind: 'activity', label: 'Revised "Induction"' }
    ])
  })

  it('recovers the user instruction from a section rewrite prompt', () => {
    const prompt = buildSectionRegenerationPrompt({
      sectionTitle: 'Deepening',
      outlineDescription: 'go further down',
      instruction: 'less repetition'
    })
    const entries = buildThread({ conversation: conversationOf([generation(prompt, 'four words go here')]) })

    expect(entries).toEqual([
      { id: 'gen-0-instruction', kind: 'user', text: 'less repetition' },
      { id: 'gen-0', kind: 'activity', label: 'Rewrote "Deepening"', detail: '4 words' }
    ])
  })

  it('names a hand-edited section without inventing a user turn', () => {
    const entries = buildThread({
      conversation: conversationOf([
        generation(
          'I have manually edited the "Emergence" section. The version below replaces the previous one.',
          '## Emergence\nWide awake'
        )
      ])
    })

    expect(entries).toEqual([
      { id: 'gen-0', kind: 'activity', label: 'Edited "Emergence" by hand' }
    ])
  })

  it('falls back to naming the sections an unrecognised pass touched', () => {
    const entries = buildThread({
      conversation: conversationOf([
        generation('Review the script for cohesion.', '## Induction\nRevised\n\n## Emergence\nRevised')
      ])
    })

    expect(entries).toEqual([
      { id: 'gen-0', kind: 'activity', label: 'Updated "Induction", "Emergence"' }
    ])
  })
})

describe('buildThread while streaming', () => {
  it('leaves the in-flight generation out of the thread', () => {
    const entries = buildThread({
      isStreaming: true,
      conversation: conversationOf([
        generation('Plan the script.', '# Deep Rest\n\n## Induction\nSettle in'),
        generation('Now write the "Induction" section of the script.', 'half a sen')
      ])
    })

    expect(entries).toEqual([
      { id: 'gen-0', kind: 'activity', label: 'Planned the outline', detail: '1 section' }
    ])
  })
})
