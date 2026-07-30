import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterSpeechEngine } from '../speechEngines'

// Stands in for the media element the engine plays through. Playback ends only
// when the test says so, which makes the engine's sequencing observable.
class FakeAudio {
  static instances: FakeAudio[] = []
  playbackRate = 1
  playCount = 0
  pauseCount = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  readonly src: string

  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }

  play(): Promise<void> {
    this.playCount += 1
    return Promise.resolve()
  }

  pause() {
    this.pauseCount += 1
  }

  end() {
    this.onended?.()
  }
}

const requestBodies = () =>
  (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.map(
    ([, init]) => JSON.parse(init.body as string)
  )

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:utterance', revokeObjectURL: () => {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('audio-bytes', { status: 200 }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const newEngine = (voice = 'Eve') =>
  new OpenRouterSpeechEngine({ apiKey: 'test-key', model: 'x-ai/grok-voice-tts-1.0', voice })

// Waits for the nth utterance to reach playback, so a test never mistakes the
// previous utterance's element for the one it is waiting on.
const nthAudio = (position = 1) =>
  vi.waitFor(() => {
    expect(FakeAudio.instances.length).toBe(position)
    return FakeAudio.instances[position - 1]
  })

const nextAudio = () => nthAudio(1)

describe('OpenRouterSpeechEngine', () => {
  it('fetches an utterance and plays it at the chosen rate', async () => {
    const engine = newEngine()
    const spoken = engine.speak('Settle back.', 1.25)

    const audio = await nextAudio()
    expect(audio.playbackRate).toBe(1.25)
    expect(audio.playCount).toBe(1)
    expect(requestBodies()[0].input).toBe('Settle back.')

    audio.end()
    await expect(spoken).resolves.toBeUndefined()
  })

  it('reuses a prefetched utterance instead of paying for it twice', async () => {
    const engine = newEngine()
    engine.prefetch('Breathe in.')
    const spoken = engine.speak('Breathe in.', 1)

    const audio = await nextAudio()
    expect(requestBodies()).toHaveLength(1)

    audio.end()
    await spoken
  })

  // reset() clears leftovers between reads; it must not retire the engine.
  it('stays usable after a reset', async () => {
    const engine = newEngine()
    engine.reset()
    const spoken = engine.speak('Still here.', 1)

    const audio = await nextAudio()
    expect(audio.playCount).toBe(1)

    audio.end()
    await spoken
  })

  it('plays nothing once cancelled', async () => {
    const engine = newEngine()
    engine.cancel()

    await expect(engine.speak('Too late.', 1)).resolves.toBeUndefined()
    expect(FakeAudio.instances).toHaveLength(0)
  })

  it('holds a fetched utterance silent until resumed', async () => {
    const engine = newEngine()
    engine.pause()
    const spoken = engine.speak('Wait for it.', 1)

    // The request may complete while paused, but nothing may be voiced.
    await vi.waitFor(() => expect(requestBodies()).toHaveLength(1))
    expect(FakeAudio.instances).toHaveLength(0)

    engine.resume()
    const audio = await nextAudio()
    expect(audio.playCount).toBe(1)

    audio.end()
    await spoken
  })

  it('pauses and resumes playback that is already under way', async () => {
    const engine = newEngine()
    const spoken = engine.speak('Mid sentence.', 1)
    const audio = await nextAudio()

    engine.pause()
    expect(audio.pauseCount).toBe(1)
    engine.resume()
    expect(audio.playCount).toBe(2)

    audio.end()
    await spoken
  })

  it('sends the newly chosen voice for later utterances', async () => {
    const engine = newEngine()
    const first = engine.speak('One.', 1)
    ;(await nextAudio()).end()
    await first

    engine.setVoice('Rex')
    const second = engine.speak('Two.', 1)
    const audio = await nthAudio(2)

    expect(requestBodies().map((body) => body.voice)).toEqual(['Eve', 'Rex'])
    audio.end()
    await second
  })

  it('rejects when the request fails, so read-aloud can report it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 }))
    )
    const engine = newEngine()

    await expect(engine.speak('Costly.', 1)).rejects.toThrow('Insufficient credits')
  })

  it('retries a failed utterance rather than replaying the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Server Error' }))
      .mockResolvedValueOnce(new Response('audio-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const engine = newEngine()

    await expect(engine.speak('Once more.', 1)).rejects.toThrow()

    const spoken = engine.speak('Once more.', 1)
    const audio = await nextAudio()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    audio.end()
    await spoken
  })
})
