import { describe, it, expect } from 'vitest'
import {
  buildSectionRegenerationPrompt,
  buildSectionRegenerationPromptFromConversation,
  getScriptRefinementPrompt,
  getSectionGenerationPrompt,
  formatUpcomingSections,
  orderExamplesForPrompt,
  formatExamplesForPrompt,
  normaliseConversationHistory,
  buildConversationHistory,
  getSystemPrompt,
  getOutlineGenerationPrompt,
  buildGenerationSystemPrompt,
  withGenerationSystemPrompt
} from '../prompts'
import { buildLengthPlan } from '../scriptLength'
import { SECTION_TARGET_WORDS } from '../sectionQuality'
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

describe('the requested length in the prompts', () => {
  it('states the target length in the system prompt', () => {
    const plan = buildLengthPlan(40)
    const prompt = getSystemPrompt(plan)

    expect(prompt).toContain('about 40 minutes')
    expect(prompt).toContain(plan.totalWords.toLocaleString('en-US'))
    expect(prompt).toContain(`approximately ${plan.sectionCount} sections`)
  })

  it('states the target as an aim rather than a limit', () => {
    expect(getSystemPrompt()).toContain('advisory')
  })

  it('turns the target into a section count for the outline', () => {
    const plan = buildLengthPlan(15)
    const prompt = getOutlineGenerationPrompt(plan)

    expect(prompt).toContain(`About ${plan.sectionCount} section headers`)
    expect(prompt).toContain('about 15 minutes')
  })

  it('leaves no length placeholders unfilled', () => {
    for (const prompt of [getSystemPrompt(), getOutlineGenerationPrompt()]) {
      expect(prompt).not.toMatch(/\{(targetMinutes|totalWords|minWords|maxWords|sectionCount|sectionWords)\}/)
    }
  })

  it('falls back to the default target when no length is given', () => {
    expect(getSystemPrompt()).toContain(`about ${buildLengthPlan().targetMinutes} minutes`)
  })
})

describe('buildSectionRegenerationPrompt', () => {
  it('names the section and includes its outline description', () => {
    const prompt = buildSectionRegenerationPrompt({
      sectionTitle: 'Deepener',
      outlineDescription: 'Descend a staircase of ten steps.'
    })

    expect(prompt).toContain('rewrite the "Deepener" section')
    expect(prompt).toContain('This section should be: Descend a staircase of ten steps.')
  })

  it('keeps the section word target and no-header rule from the section approach', () => {
    const prompt = buildSectionRegenerationPrompt({ sectionTitle: 'Deepener' })

    expect(prompt).toContain(`approximately ${SECTION_TARGET_WORDS} words`)
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
  const makeExample = (title: string, score: number): ExampleScript => ({
    content: `Body of ${title}`,
    metadata: { id: `${title}-id`, title, source: 'bundled', tags: '' },
    score
  })

  // Search results arrive ranked most-relevant-first
  const rankedExamples = [
    makeExample('Best Script', 0.9),
    makeExample('Middle Script', 0.5),
    makeExample('Worst Script', 0.1)
  ]

  it('orders examples so the most relevant is last', () => {
    const ordered = orderExamplesForPrompt(rankedExamples)

    expect(ordered.map(example => example.metadata?.title)).toEqual([
      'Worst Script',
      'Middle Script',
      'Best Script'
    ])
  })

  it('does not mutate the ranked input', () => {
    const input = [...rankedExamples]
    orderExamplesForPrompt(input)

    expect(input).toEqual(rankedExamples)
  })

  it('places the most relevant example closest to the end of the formatted block', () => {
    const formatted = formatExamplesForPrompt(rankedExamples)

    const bestIndex = formatted.indexOf('Best Script')
    const middleIndex = formatted.indexOf('Middle Script')
    const worstIndex = formatted.indexOf('Worst Script')

    expect(worstIndex).toBeGreaterThan(-1)
    expect(worstIndex).toBeLessThan(middleIndex)
    expect(middleIndex).toBeLessThan(bestIndex)
    expect(formatted).toContain('### Example 3: Best Script')
  })
})

describe('exemplar labelling', () => {
  it('labels each example with its metadata title', () => {
    const formatted = formatExamplesForPrompt([
      { content: 'Body', metadata: { id: 'ex-1', title: 'Deep Relaxation' } }
    ])

    expect(formatted).toContain('### Example 1: Deep Relaxation')
    expect(formatted).not.toContain('Unknown')
  })

  it('falls back to the legacy filename when there is no title', () => {
    const formatted = formatExamplesForPrompt([
      { content: 'Body', metadata: { filename: 'legacy.md' } }
    ])

    expect(formatted).toContain('### Example 1: legacy.md')
  })

  it('falls back to the id when there is neither title nor filename', () => {
    const formatted = formatExamplesForPrompt([{ content: 'Body', metadata: { id: 'ex-7' } }])

    expect(formatted).toContain('### Example 1: ex-7')
  })

  it('leaves the heading unlabelled when the metadata names nothing', () => {
    for (const example of [
      { content: 'Body' },
      { content: 'Body', metadata: { source: 'user' } }
    ] as ExampleScript[]) {
      const formatted = formatExamplesForPrompt([example])

      expect(formatted).toContain('### Example 1\n\nBody')
      expect(formatted).not.toContain('Unknown')
      expect(formatted).not.toContain('### Example 1:')
    }
  })

  it('lists the example tags beneath the heading', () => {
    const formatted = formatExamplesForPrompt([
      { content: 'Body', metadata: { title: 'Deep Relaxation', tags: 'anxiety, sleep' } }
    ])

    expect(formatted).toContain('### Example 1: Deep Relaxation\n\nTags: anxiety, sleep\n\nBody')
  })

  it('omits the tag line when the example has no tags', () => {
    const formatted = formatExamplesForPrompt([
      { content: 'Body', metadata: { title: 'Deep Relaxation', tags: '' } }
    ])

    expect(formatted).toContain('### Example 1: Deep Relaxation\n\nBody')
    expect(formatted).not.toContain('Tags:')
  })

  it('keeps a title with a newline from breaking the heading', () => {
    const formatted = formatExamplesForPrompt([
      { content: 'Body', metadata: { title: 'Deep\n## Injected' } }
    ])

    expect(formatted).toContain('### Example 1: Deep ## Injected')
  })

  it('contributes nothing at all when the corpus is empty', () => {
    expect(formatExamplesForPrompt([])).toBe('')
  })
})

describe('the generation system prompt', () => {
  const example: ExampleScript = {
    content: 'A candle gutters in still air.',
    metadata: { id: 'ex-candle', title: 'Candle Flame' }
  }

  it('is the plain system prompt when there are no examples', () => {
    const plan = buildLengthPlan(30)

    expect(buildGenerationSystemPrompt(plan, [])).toBe(getSystemPrompt(plan))
  })

  it('appends the ordered example block when there are examples', () => {
    const plan = buildLengthPlan(30)
    const prompt = buildGenerationSystemPrompt(plan, [example])

    expect(prompt.startsWith(getSystemPrompt(plan))).toBe(true)
    expect(prompt).toContain('## Examples')
    expect(prompt).toContain('A candle gutters in still air.')
  })

  it('swaps only the system turn of a message array', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'lean system' },
      { role: 'user', content: 'the brief' },
      { role: 'assistant', content: 'the outline' }
    ]

    const swapped = withGenerationSystemPrompt(messages, 'system with examples')

    expect(swapped).toEqual([
      { role: 'system', content: 'system with examples' },
      { role: 'user', content: 'the brief' },
      { role: 'assistant', content: 'the outline' }
    ])
    expect(messages[0].content).toBe('lean system')
  })

  // History replayed from storage has no system turn, so there is nothing to
  // replace and the corpus would otherwise never reach a rewrite
  it('prepends a system turn to a history that has none', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'the brief' }]

    expect(withGenerationSystemPrompt(messages, 'system with examples')).toEqual([
      { role: 'system', content: 'system with examples' },
      { role: 'user', content: 'the brief' }
    ])
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

  it('holds a rewritten section to the same word target as a generated one', () => {
    const prompt = getScriptRefinementPrompt('remove the counting')

    expect(prompt).toContain(`approximately ${SECTION_TARGET_WORDS} words`)
    expect(prompt).not.toContain('{targetWords}')
    expect(prompt).not.toContain('approximately 400 words')
  })
})

describe('getSectionGenerationPrompt upcoming sections (story 8.10)', () => {
  const upcoming = [
    { title: 'Deepener', description: 'Descend a staircase of ten steps.' },
    { title: 'Awakening', description: 'Count back up to full alertness.' }
  ]

  it('lists the title and summary of every upcoming section', () => {
    const prompt = getSectionGenerationPrompt('Induction', 'Settle the listener.', upcoming)

    expect(prompt).toContain('Still to come after this section')
    expect(prompt).toContain('- "Deepener": Descend a staircase of ten steps.')
    expect(prompt).toContain('- "Awakening": Count back up to full alertness.')
    expect(prompt).toContain('plant setups')
  })

  it('omits the upcoming block for the final section', () => {
    const prompt = getSectionGenerationPrompt('Awakening', 'Count back up.', [])

    expect(prompt).not.toContain('Still to come after this section')
    expect(prompt).not.toContain('{upcomingSections}')
  })

  it('omits the upcoming block when no upcoming sections are given', () => {
    const prompt = getSectionGenerationPrompt('Awakening', 'Count back up.')

    expect(prompt).not.toContain('Still to come after this section')
    expect(prompt).not.toContain('{upcomingSections}')
  })

  it('keeps the section title, description and requirements intact', () => {
    const prompt = getSectionGenerationPrompt('Induction', 'Settle the listener.', upcoming)

    expect(prompt).toContain('Now write the "Induction" section')
    expect(prompt).toContain('This section should be: Settle the listener.')
    expect(prompt).toContain(`approximately ${SECTION_TARGET_WORDS} words`)
  })

  it('formatUpcomingSections is not corrupted by replacement patterns', () => {
    const block = formatUpcomingSections([
      { title: 'Costs', description: "Roughly $100, or $& in shorthand." }
    ])

    expect(block).toContain("Roughly $100, or $& in shorthand.")
  })
})
