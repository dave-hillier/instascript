import { describe, it, expect } from 'vitest'
import { findResumeState } from '../rawScriptGenerationOrchestrator'
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

describe('findResumeState', () => {
  it('returns null for a conversation with no generations', () => {
    expect(findResumeState(makeConversation([]))).toBeNull()
  })

  it('returns null when no generation parses as an outline', () => {
    const conversation = makeConversation(['## Induction\nBreathe in slowly.'])
    expect(findResumeState(conversation)).toBeNull()
  })

  it('returns null when the outline is the last generation, since it may be truncated', () => {
    const conversation = makeConversation([outlineText])
    expect(findResumeState(conversation)).toBeNull()
  })

  it('resumes from an outline that a later generation proves complete', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nClose your eyes and breathe.'
    ])

    const resume = findResumeState(conversation)
    expect(resume).not.toBeNull()
    expect(resume?.outline.title).toBe('Deep Rest')
    expect(resume?.outline.sections.map(s => s.title)).toEqual([
      'Induction',
      'Deepener',
      'Awakening'
    ])
    expect(resume?.outlineText).toBe(outlineText)
    expect(resume?.sectionTexts.get('Induction')).toBe('Close your eyes and breathe.')
  })

  it('collects every generated section following the outline', () => {
    const conversation = makeConversation([
      outlineText,
      '## Induction\nClose your eyes and breathe.',
      '## Deepener\nTen steps down, one at a time.'
    ])

    const resume = findResumeState(conversation)
    expect(resume?.sectionTexts.size).toBe(2)
    expect(resume?.sectionTexts.get('Deepener')).toBe('Ten steps down, one at a time.')
  })

  it('ignores a section generation with an empty body', () => {
    const conversation = makeConversation([outlineText, '## Induction\n'])

    const resume = findResumeState(conversation)
    expect(resume).not.toBeNull()
    expect(resume?.sectionTexts.size).toBe(0)
  })

  it('uses the most recent outline when a retry produced a fresh one', () => {
    const secondOutline = [
      '# Quiet Descent',
      '## Arrival',
      'Arrive in the moment.',
      '## Return',
      'Return refreshed.'
    ].join('\n')
    const conversation = makeConversation([
      outlineText,
      '## Induction\nOld run content.',
      secondOutline,
      '## Arrival\nNew run content.'
    ])

    const resume = findResumeState(conversation)
    expect(resume?.outline.title).toBe('Quiet Descent')
    expect(resume?.sectionTexts.get('Arrival')).toBe('New run content.')
    expect(resume?.sectionTexts.has('Induction')).toBe(false)
  })
})
