import { describe, it, expect } from 'vitest'
import {
  buildSectionRegenerationPrompt,
  buildSectionRegenerationPromptFromConversation,
  getScriptRefinementPrompt,
  orderExamplesForPrompt,
  formatExamplesForPrompt,
  normaliseConversationHistory,
  buildConversationHistory
} from '../prompts'
import type { RawConversation, Generation, ChatMessage } from '../../types/conversation'
import type { ExampleScript } from '../exampleSearchService'

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

describe('exemplar ordering (story 8.8)', () => {
  const makeExample = (filename: string, score: number): ExampleScript => ({
    content: `Body of ${filename}`,
    metadata: { filename },
    score
  })

  // Search results arrive ranked most-relevant-first
  const rankedExamples = [
    makeExample('best.md', 0.9),
    makeExample('middle.md', 0.5),
    makeExample('worst.md', 0.1)
  ]

  it('orders examples so the most relevant is last', () => {
    const ordered = orderExamplesForPrompt(rankedExamples)

    expect(ordered.map(example => example.metadata?.filename)).toEqual([
      'worst.md',
      'middle.md',
      'best.md'
    ])
  })

  it('does not mutate the ranked input', () => {
    const input = [...rankedExamples]
    orderExamplesForPrompt(input)

    expect(input).toEqual(rankedExamples)
  })

  it('places the most relevant example closest to the end of the formatted block', () => {
    const formatted = formatExamplesForPrompt(rankedExamples)

    const bestIndex = formatted.indexOf('best.md')
    const middleIndex = formatted.indexOf('middle.md')
    const worstIndex = formatted.indexOf('worst.md')

    expect(worstIndex).toBeGreaterThan(-1)
    expect(worstIndex).toBeLessThan(middleIndex)
    expect(middleIndex).toBeLessThan(bestIndex)
    expect(formatted).toContain('### Example 3: best.md')
  })
})

describe('conversation history normalisation (story 8.13)', () => {
  const systemPrompt = 'You are a hypnosis script writer.'

  const makeRefinedConversation = (): RawConversation => {
    // Generations store the complete messages array each request was sent
    // with, so after two refinements the flattened history holds three
    // system messages plus a stray divergent one
    const initialMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Write a relaxation script' }
    ]
    const firstRefinementMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Write a relaxation script' },
      { role: 'assistant', content: '## Induction\nFirst draft.' },
      { role: 'user', content: 'Make the induction slower' }
    ]
    const secondRefinementMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: 'Focus on breathing imagery.' },
      { role: 'user', content: 'Make the induction slower' },
      { role: 'assistant', content: '## Induction\nSlower draft.' },
      { role: 'user', content: 'Remove the counting' }
    ]

    return {
      id: 'conv-1',
      scriptId: 'script-1',
      generations: [
        { messages: initialMessages, response: '## Induction\nFirst draft.', timestamp: 0 },
        { messages: firstRefinementMessages, response: '## Induction\nSlower draft.', timestamp: 1 },
        { messages: secondRefinementMessages, response: '## Induction\nFinal draft.', timestamp: 2 }
      ],
      createdAt: 0,
      updatedAt: 0
    }
  }

  it('flattens a multi-refinement conversation to exactly one system message', () => {
    const history = buildConversationHistory(makeRefinedConversation(), 'Add a longer awakening')

    const systemMessages = history.filter(message => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].content).toBe(systemPrompt)
  })

  it('puts the single system message first and the new instruction last', () => {
    const history = buildConversationHistory(makeRefinedConversation(), 'Add a longer awakening')

    expect(history[0]).toEqual({ role: 'system', content: systemPrompt })
    expect(history[history.length - 1]).toEqual({ role: 'user', content: 'Add a longer awakening' })
  })

  it('expresses a divergent later system turn as a user turn', () => {
    const history = buildConversationHistory(makeRefinedConversation(), 'Add a longer awakening')

    expect(history).toContainEqual({ role: 'user', content: 'Focus on breathing imagery.' })
  })

  it('leaves a history with no system message unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' }
    ]

    expect(normaliseConversationHistory(messages)).toEqual(messages)
  })

  it('drops repeated identical system messages without adding user turns', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'First' },
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Second' }
    ]

    expect(normaliseConversationHistory(messages)).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Second' }
    ])
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
