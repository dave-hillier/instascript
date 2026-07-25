import { describe, it, expect } from 'vitest'
import { buildConsolidatedMarkdown, markdownFilename } from '../scriptExport'
import type { RawConversation, Generation } from '../../types/conversation'

const makeGeneration = (response: string): Generation => ({
  messages: [{ role: 'user', content: 'prompt' }],
  response,
  timestamp: 1
})

const makeConversation = (responses: string[]): RawConversation => ({
  id: 'conv_1',
  scriptId: 'script_1',
  generations: responses.map(makeGeneration),
  createdAt: 1,
  updatedAt: 1
})

describe('buildConsolidatedMarkdown', () => {
  it('returns empty string when there are no section generations', () => {
    expect(buildConsolidatedMarkdown(makeConversation([]))).toBe('')
    expect(buildConsolidatedMarkdown(makeConversation(['# Outline Only\n## Induction\nplan']))).toBe('')
  })

  it('uses the outline title and joins sections with headings', () => {
    const conversation = makeConversation([
      '# The Drifting Shore\n## Induction\nplanned induction\n## Deepening\nplanned deepening',
      '## Induction\nBreathe in…',
      '## Deepening\nDeeper now.'
    ])

    expect(buildConsolidatedMarkdown(conversation)).toBe(
      '# The Drifting Shore\n\n## Induction\nBreathe in…\n\n## Deepening\nDeeper now.'
    )
  })

  it('reflects regenerated and edited sections: last generation with a title wins', () => {
    const conversation = makeConversation([
      '# Title\n## Induction\nplan\n## Return\nplan',
      '## Induction\nOriginal induction.',
      '## Return\nOriginal return.',
      '## Induction\nEdited induction.'
    ])

    expect(buildConsolidatedMarkdown(conversation)).toBe(
      '# Title\n\n## Induction\nEdited induction.\n\n## Return\nOriginal return.'
    )
  })

  it('prefers a preferredTitle over the outline title (manual rename wins)', () => {
    const conversation = makeConversation([
      '# Old Outline Title\n## Induction\nplan',
      '## Induction\nBreathe.'
    ])
    expect(buildConsolidatedMarkdown(conversation, 'Fallback', 'Renamed Script')).toBe(
      '# Renamed Script\n\n## Induction\nBreathe.'
    )
  })

  it('falls back to the provided title when no outline exists', () => {
    const conversation = makeConversation(['## Induction\nBreathe.'])
    expect(buildConsolidatedMarkdown(conversation, 'My Script')).toBe(
      '# My Script\n\n## Induction\nBreathe.'
    )
  })
})

describe('markdownFilename', () => {
  it('slugifies the title', () => {
    expect(markdownFilename('A Quiet Descent')).toBe('a-quiet-descent.md')
  })

  it('strips punctuation and collapses separators', () => {
    expect(markdownFilename('  Drift: down / deeper!  ')).toBe('drift-down-deeper.md')
  })

  it('falls back for an empty or symbol-only title', () => {
    expect(markdownFilename('')).toBe('script.md')
    expect(markdownFilename('***')).toBe('script.md')
  })

  it('keeps unicode letters', () => {
    expect(markdownFilename('Rêve Profond')).toBe('rêve-profond.md')
  })
})
