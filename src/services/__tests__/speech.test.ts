import { describe, expect, it } from 'vitest'
import {
  DASH_PAUSE_MS,
  ELLIPSIS_PAUSE_MS,
  PARAGRAPH_PAUSE_MS,
  buildSpeechPlan,
  isSpeechSynthesisSupported,
  pauseDurationMs,
} from '../speech'

describe('pauseDurationMs', () => {
  it('gives a short beat for an ellipsis', () => {
    expect(pauseDurationMs('…')).toBe(ELLIPSIS_PAUSE_MS)
  })

  it('accumulates repeated ellipses', () => {
    expect(pauseDurationMs('……')).toBe(2 * ELLIPSIS_PAUSE_MS)
  })

  it('gives a long beat for a pacing dash', () => {
    expect(pauseDurationMs('⏤')).toBe(DASH_PAUSE_MS)
  })

  it('combines mixed marks', () => {
    expect(pauseDurationMs('…⏤')).toBe(ELLIPSIS_PAUSE_MS + DASH_PAUSE_MS)
  })

  it('treats a literal three-dot ellipsis as one beat', () => {
    expect(pauseDurationMs('...')).toBe(ELLIPSIS_PAUSE_MS)
  })

  it('scales long dot runs by groups of three', () => {
    expect(pauseDurationMs('......')).toBe(2 * ELLIPSIS_PAUSE_MS)
  })
})

describe('buildSpeechPlan', () => {
  it('turns a plain line into a single utterance keyed to its paragraph', () => {
    const plan = buildSpeechPlan([{ content: 'Take a deep breath.' }])
    expect(plan).toEqual([
      { kind: 'speech', text: 'Take a deep breath.', paragraphKey: 'line-0-0' },
    ])
  })

  it('splits at pacing marks and inserts matching pauses', () => {
    const plan = buildSpeechPlan([{ content: 'Breathe in… and let it go ⏤ slowly.' }])
    expect(plan).toEqual([
      { kind: 'speech', text: 'Breathe in', paragraphKey: 'line-0-0' },
      { kind: 'pause', durationMs: ELLIPSIS_PAUSE_MS, paragraphKey: 'line-0-0' },
      { kind: 'speech', text: 'and let it go', paragraphKey: 'line-0-0' },
      { kind: 'pause', durationMs: DASH_PAUSE_MS, paragraphKey: 'line-0-0' },
      { kind: 'speech', text: 'slowly.', paragraphKey: 'line-0-0' },
    ])
  })

  it('does not speak stage directions', () => {
    const plan = buildSpeechPlan([{ content: 'Settle back. [long pause] Good.' }])
    expect(plan.every((item) => item.kind !== 'speech' || !item.text.includes('['))).toBe(true)
    expect(plan.filter((item) => item.kind === 'speech').map((item) => item.text))
      .toEqual(['Settle back.', 'Good.'])
  })

  it('pauses between paragraphs and skips blank lines and headings', () => {
    const plan = buildSpeechPlan([{ content: '## Induction\nFirst line.\n\nSecond line.' }])
    expect(plan).toEqual([
      { kind: 'speech', text: 'First line.', paragraphKey: 'line-0-1' },
      { kind: 'pause', durationMs: PARAGRAPH_PAUSE_MS, paragraphKey: 'line-0-3' },
      { kind: 'speech', text: 'Second line.', paragraphKey: 'line-0-3' },
    ])
  })

  it('keys paragraphs by section and pre-filter line index across sections', () => {
    const plan = buildSpeechPlan([
      { content: 'One.' },
      { content: 'Two.' },
    ])
    expect(plan).toEqual([
      { kind: 'speech', text: 'One.', paragraphKey: 'line-0-0' },
      { kind: 'pause', durationMs: PARAGRAPH_PAUSE_MS, paragraphKey: 'line-1-0' },
      { kind: 'speech', text: 'Two.', paragraphKey: 'line-1-0' },
    ])
  })

  it('keeps the trailing pause when a line ends with a pacing mark', () => {
    const plan = buildSpeechPlan([{ content: 'Drift down…' }])
    expect(plan).toEqual([
      { kind: 'speech', text: 'Drift down', paragraphKey: 'line-0-0' },
      { kind: 'pause', durationMs: ELLIPSIS_PAUSE_MS, paragraphKey: 'line-0-0' },
    ])
  })
})

describe('isSpeechSynthesisSupported', () => {
  it('reports unsupported in environments without the API', () => {
    // jsdom provides neither speechSynthesis nor SpeechSynthesisUtterance
    expect(isSpeechSynthesisSupported()).toBe(false)
  })
})
