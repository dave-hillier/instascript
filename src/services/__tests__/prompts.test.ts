import { describe, it, expect } from 'vitest'
import {
  buildSectionRegenerationPrompt,
  buildSectionRegenerationPromptFromConversation,
  getScriptRefinementPrompt
} from '../prompts'
import type { RawConversation, Generation } from '../../types/conversation'

const makeGeneration = (response: string): Generation => ({
  messages: [],
  response,
  timestamp: 0
})

const makeConversation = (responses: string[]): RawConversation => ({
  id: 'conv-1',
  scriptId: 'script-1',
  generations: responses.map(makeGeneration),
  createdAt: 0,
  updatedAt: 0
})

const outlineText = [
  '# Deep Rest',
  '## Induction',
  'Settle the listener with slow breathing.',
  '## Deepener',
  'Descend a staircase of ten steps.',
  '## Awakening',
  'Count back up to full alertness.'
].join('\n')

const words = (count: number, word = 'word'): string =>
  Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ')

describe('buildSectionRegenerationPrompt', () => {
  it('names the section and includes its outline description', () => {
    const prompt = buildSectionRegenerationPrompt({
      sectionTitle: 'Deepener',
      outlineDescription: 'Descend a staircase of ten steps.'
    })

    expect(prompt).toContain('rewrite the "Deepener" section')
    expect(prompt).toContain('This section should be: Descend a staircase of ten steps.')
  })

  it('keeps the ~400-word target and no-header rule from the section approach', () => {
    const prompt = buildSectionRegenerationPrompt({ sectionTitle: 'Deepener' })

    expect(prompt).toContain('approximately 400 words')
    expect(prompt).toContain('do NOT include the ## header')
  })

  it('falls back to a generic description when the outline has no entry', () => {
    const prompt = buildSectionRegenerationPrompt({ sectionTitle: 'Deepener' })

    expect(prompt).toContain(
      'This section should be: consistent with its current role and position in the script'
    )
  })

  it('includes the end of the preceding section and the start of the following one', () => {
    const prompt = buildSectionRegenerationPrompt({
      sectionTitle: 'Deepener',
      previousSection: { title: 'Induction', content: 'Close your eyes and drift.' },
      nextSection: { title: 'Awakening', content: 'Count from one to five.' }
    })

    expect(prompt).toContain('The preceding section "Induction" currently ends with:')
    expect(prompt).toContain('Close your eyes and drift.')
    expect(prompt).toContain('The following section "Awakening" currently begins with:')
    expect(prompt).toContain('Count from one to five.')
  })

  it('truncates long neighbouring sections to an excerpt', () => {
    const longContent = words(100)
    const prompt = buildSectionRegenerationPrompt({
      sectionTitle: 'Deepener',
      previousSection: { title: 'Induction', content: longContent },
      nextSection: { title: 'Awakening', content: longContent }
    })

    // Preceding excerpt keeps the last 75 words, not the first ones
    expect(prompt).toContain('… word25')
    expect(prompt).not.toContain('ends with:\n\nword0')
    // Following excerpt keeps the first 75 words, not the last ones
    expect(prompt).toContain('word74 …')
  })

  it('omits continuity context when there are no neighbouring sections', () => {
    const prompt = buildSectionRegenerationPrompt({ sectionTitle: 'Induction' })

    expect(prompt).not.toContain('preceding section')
    expect(prompt).not.toContain('following section')
  })

  it('appends a non-empty custom instruction', () => {
    const prompt = buildSectionRegenerationPrompt({
      sectionTitle: 'Deepener',
      instruction: 'less repetition, more breathing focus'
    })

    expect(prompt).toContain('Additional instruction from the user for this rewrite:')
    expect(prompt).toContain('less repetition, more breathing focus')
  })

  it('ignores an empty or whitespace-only instruction', () => {
    const emptyPrompt = buildSectionRegenerationPrompt({ sectionTitle: 'Deepener' })
    const blankPrompt = buildSectionRegenerationPrompt({ sectionTitle: 'Deepener', instruction: '   ' })

    expect(blankPrompt).toBe(emptyPrompt)
    expect(blankPrompt).not.toContain('Additional instruction')
  })
})

describe('buildSectionRegenerationPromptFromConversation', () => {
  const conversation = makeConversation([
    outlineText,
    '## Induction\nOriginal induction body.',
    '## Deepener\nDeepener body.',
    '## Awakening\nAwakening body.'
  ])

  it('uses the outline entry from generation 0 as the section description', () => {
    const prompt = buildSectionRegenerationPromptFromConversation(conversation, 'Deepener')

    expect(prompt).toContain('This section should be: Descend a staircase of ten steps.')
  })

  it('uses the surrounding sections for continuity', () => {
    const prompt = buildSectionRegenerationPromptFromConversation(conversation, 'Deepener')

    expect(prompt).toContain('The preceding section "Induction" currently ends with:')
    expect(prompt).toContain('Original induction body.')
    expect(prompt).toContain('The following section "Awakening" currently begins with:')
    expect(prompt).toContain('Awakening body.')
  })

  it('uses the current (regenerated) neighbour content, not the original', () => {
    const withRegeneratedNeighbour = makeConversation([
      outlineText,
      '## Induction\nOriginal induction body.',
      '## Deepener\nDeepener body.',
      '## Awakening\nAwakening body.',
      '## Induction\nRewritten induction body.'
    ])

    const prompt = buildSectionRegenerationPromptFromConversation(withRegeneratedNeighbour, 'Deepener')

    expect(prompt).toContain('Rewritten induction body.')
    expect(prompt).not.toContain('Original induction body.')
  })

  it('has no preceding section for the first section and none following the last', () => {
    const firstPrompt = buildSectionRegenerationPromptFromConversation(conversation, 'Induction')
    const lastPrompt = buildSectionRegenerationPromptFromConversation(conversation, 'Awakening')

    expect(firstPrompt).not.toContain('preceding section')
    expect(firstPrompt).toContain('The following section "Deepener"')
    expect(lastPrompt).toContain('The preceding section "Deepener"')
    expect(lastPrompt).not.toContain('following section')
  })

  it('passes the custom instruction through', () => {
    const prompt = buildSectionRegenerationPromptFromConversation(
      conversation,
      'Deepener',
      'slow the pacing right down'
    )

    expect(prompt).toContain('slow the pacing right down')
  })
})

describe('getScriptRefinementPrompt', () => {
  it('embeds the trimmed user instruction', () => {
    const prompt = getScriptRefinementPrompt('  make the induction slower  ')

    expect(prompt).toContain('make the induction slower')
    expect(prompt).not.toContain('  make the induction slower  ')
  })

  it('asks for only the changed sections in "## Section" format', () => {
    const prompt = getScriptRefinementPrompt('remove the counting')

    expect(prompt).toContain('rewriting ONLY the sections that need to change')
    expect(prompt).toContain('"## Section Title" header line')
    expect(prompt).toContain('Do not output sections that do not need to change')
  })
})
