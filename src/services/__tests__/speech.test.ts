import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DASH_PAUSE_MS,
  ELLIPSIS_PAUSE_MS,
  PARAGRAPH_PAUSE_MS,
  ScriptSpeaker,
  buildSpeechPlan,
  isSpeechSynthesisSupported,
  pauseDurationMs,
} from '../speech'
import type { SpeechEngine } from '../speechEngines'

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

// Stands in for either real engine: utterances finish only when the test says
// so, which is how the speaker's own sequencing becomes observable.
class FakeSpeechEngine implements SpeechEngine {
  spoken: string[] = []
  prefetched: string[] = []
  voice = ''
  cancelCount = 0
  resetCount = 0
  pauseCount = 0
  resumeCount = 0
  failWith: Error | null = null
  private finishers: Array<() => void> = []

  speak(text: string): Promise<void> {
    this.spoken.push(text)
    if (this.failWith) {
      const failure = this.failWith
      this.failWith = null
      return Promise.reject(failure)
    }
    return new Promise<void>((resolve) => this.finishers.push(resolve))
  }

  finishUtterance() {
    this.finishers.shift()?.()
  }

  prefetch(text: string) {
    this.prefetched.push(text)
  }

  setVoice(voice: string) {
    this.voice = voice
  }

  reset() {
    this.resetCount += 1
  }

  pause() {
    this.pauseCount += 1
  }

  resume() {
    this.resumeCount += 1
  }

  cancel() {
    this.cancelCount += 1
  }
}

describe('ScriptSpeaker', () => {
  const twoLinePlan = () => buildSpeechPlan([{ content: '## Induction\nOne.\nTwo.' }])

  let engine: FakeSpeechEngine
  let finished: boolean
  let failure: string | null
  let spokenKeys: string[]

  const speakerFor = (rate = 1) => {
    engine = new FakeSpeechEngine()
    finished = false
    failure = null
    spokenKeys = []
    return new ScriptSpeaker(twoLinePlan(), engine, { rate }, {
      onParagraphSpoken: (key) => spokenKeys.push(key),
      onFinished: () => { finished = true },
      onFailed: (message) => { failure = message },
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('speaks each line in turn, waiting out the silence between them', async () => {
    const speaker = speakerFor()
    speaker.start()

    expect(engine.spoken).toEqual(['One.'])
    engine.finishUtterance()

    // The paragraph pause has to elapse before the next line is voiced.
    await vi.advanceTimersByTimeAsync(PARAGRAPH_PAUSE_MS - 1)
    expect(engine.spoken).toEqual(['One.'])
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.spoken).toEqual(['One.', 'Two.'])

    engine.finishUtterance()
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(true)
  })

  it('never sends a section heading to the engine', async () => {
    const speaker = speakerFor()
    speaker.start()
    engine.finishUtterance()
    await vi.advanceTimersByTimeAsync(PARAGRAPH_PAUSE_MS)

    expect(engine.spoken).not.toContain('## Induction')
    expect(engine.spoken.some((text) => text.startsWith('#'))).toBe(false)
  })

  it('fetches the next utterance while the current one plays', () => {
    const speaker = speakerFor()
    speaker.start()

    expect(engine.prefetched).toEqual(['Two.'])
  })

  it('reports the paragraph being spoken so the view can follow', async () => {
    const speaker = speakerFor()
    speaker.start()
    engine.finishUtterance()
    await vi.advanceTimersByTimeAsync(PARAGRAPH_PAUSE_MS)

    expect(spokenKeys).toEqual(['line-0-1', 'line-0-2', 'line-0-2'])
  })

  it('scales the silence by the chosen rate', async () => {
    const speaker = speakerFor(2)
    speaker.start()
    engine.finishUtterance()

    await vi.advanceTimersByTimeAsync(PARAGRAPH_PAUSE_MS / 2)
    expect(engine.spoken).toEqual(['One.', 'Two.'])
  })

  it('suspends the silence while paused and resumes what is left of it', async () => {
    const speaker = speakerFor()
    speaker.start()
    engine.finishUtterance()

    await vi.advanceTimersByTimeAsync(100)
    speaker.pause()
    await vi.advanceTimersByTimeAsync(5000)
    expect(engine.spoken).toEqual(['One.'])

    speaker.resume()
    await vi.advanceTimersByTimeAsync(PARAGRAPH_PAUSE_MS - 100)
    expect(engine.spoken).toEqual(['One.', 'Two.'])
  })

  it('pauses through the engine when a line is mid-utterance', () => {
    const speaker = speakerFor()
    speaker.start()

    speaker.pause()
    expect(engine.pauseCount).toBe(1)
    speaker.resume()
    expect(engine.resumeCount).toBe(1)
  })

  it('stops and reports when an utterance cannot be voiced', async () => {
    const speaker = speakerFor()
    engine.failWith = new Error('No auth credentials found')
    speaker.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(failure).toBe('No auth credentials found')
    expect(finished).toBe(false)
    expect(engine.cancelCount).toBeGreaterThan(0)
  })

  // Starting must only clear what a previous read left behind. Cancelling
  // instead would retire a network-backed engine before its first request.
  it('resets the engine on start rather than cancelling it', () => {
    const speaker = speakerFor()
    speaker.start()

    expect(engine.resetCount).toBe(1)
    expect(engine.cancelCount).toBe(0)
    expect(engine.spoken).toEqual(['One.'])
  })

  it('cancels the engine when stopped part-way', () => {
    const speaker = speakerFor()
    speaker.start()

    speaker.stop()
    expect(engine.cancelCount).toBe(1)
  })

  it('speaks nothing more after being stopped', async () => {
    const speaker = speakerFor()
    speaker.start()
    speaker.stop()
    engine.finishUtterance()

    await vi.advanceTimersByTimeAsync(5000)
    expect(engine.spoken).toEqual(['One.'])
    expect(finished).toBe(false)
  })

  it('passes a voice change to the engine for the lines still to come', () => {
    const speaker = speakerFor()
    speaker.start()

    speaker.setVoice('Rex')
    expect(engine.voice).toBe('Rex')
  })
})

describe('isSpeechSynthesisSupported', () => {
  it('reports unsupported in environments without the API', () => {
    // jsdom provides neither speechSynthesis nor SpeechSynthesisUtterance
    expect(isSpeechSynthesisSupported()).toBe(false)
  })
})
