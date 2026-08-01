import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TTS_MODEL,
  SpeechRequestFailed,
  TTS_MODELS,
  defaultVoiceForModel,
  findTtsModel,
  parseRetryAfterMs,
  synthesizeSpeech,
  synthesizeSpeechWithRetry,
  type SpeechRetryNotice,
} from '../openrouterTts'
import { speechCacheKey } from '../speechAudioCache'

const audioResponse = (body = 'audio-bytes') =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })

const stubFetch = (response: Response) => {
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('synthesizeSpeech', () => {
  it('posts the utterance to the OpenRouter speech endpoint', async () => {
    const fetchMock = stubFetch(audioResponse())

    await synthesizeSpeech({
      apiKey: 'test-key',
      model: 'x-ai/grok-voice-tts-1.0',
      voice: 'Eve',
      text: 'Settle back.',
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'x-ai/grok-voice-tts-1.0',
      input: 'Settle back.',
      voice: 'Eve',
      response_format: 'mp3',
    })
  })

  it('returns the audio body', async () => {
    stubFetch(audioResponse('spoken'))

    const audio = await synthesizeSpeech({
      apiKey: 'test-key',
      model: DEFAULT_TTS_MODEL,
      voice: 'Eve',
      text: 'Breathe.',
    })

    expect(await audio.text()).toBe('spoken')
  })

  it('omits the voice for models that only support their own default', async () => {
    const fetchMock = stubFetch(audioResponse())

    await synthesizeSpeech({ apiKey: 'k', model: 'hexgrad/kokoro-82m', voice: '', text: 'Hello.' })

    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string))
      .not.toHaveProperty('voice')
  })

  it('surfaces the provider message when the request is rejected', async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), {
        status: 401,
        statusText: 'Unauthorized',
      })
    )

    await expect(
      synthesizeSpeech({ apiKey: 'bad', model: DEFAULT_TTS_MODEL, voice: 'Eve', text: 'Hello.' })
    ).rejects.toThrow('No auth credentials found')
  })

  it('falls back to the status when the error body is not JSON', async () => {
    stubFetch(new Response('gateway down', { status: 502, statusText: 'Bad Gateway' }))

    await expect(
      synthesizeSpeech({ apiKey: 'k', model: DEFAULT_TTS_MODEL, voice: 'Eve', text: 'Hello.' })
    ).rejects.toThrow('502 Bad Gateway')
  })

  it('carries the status and the wait OpenRouter asked for', async () => {
    stubFetch(
      new Response('slow down', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '7' },
      })
    )

    const failure = await synthesizeSpeech({
      apiKey: 'k',
      model: DEFAULT_TTS_MODEL,
      voice: 'Eve',
      text: 'Hello.',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SpeechRequestFailed)
    expect((failure as SpeechRequestFailed).status).toBe(429)
    expect((failure as SpeechRequestFailed).retryAfterMs).toBe(7000)
  })
})

describe('parseRetryAfterMs', () => {
  it('reads a wait given in seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000)
  })

  it('reads a wait given as a date, relative to now', () => {
    const now = Date.parse('2026-08-01T12:00:00Z')
    expect(parseRetryAfterMs('Sat, 01 Aug 2026 12:00:05 GMT', now)).toBe(5000)
  })

  it('never asks for a wait in the past', () => {
    const now = Date.parse('2026-08-01T12:00:00Z')
    expect(parseRetryAfterMs('Sat, 01 Aug 2026 11:59:00 GMT', now)).toBe(0)
  })

  it('has nothing to say without a header, or with an unreadable one', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
  })
})

describe('synthesizeSpeechWithRetry', () => {
  const utterance = { apiKey: 'k', model: DEFAULT_TTS_MODEL, voice: 'Eve', text: 'Breathe.' }

  const rateLimited = (retryAfter?: string) =>
    new Response('slow down', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
    })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks again after a rate limit and returns the audio', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited('1'))
      .mockResolvedValueOnce(audioResponse('spoken'))
    vi.stubGlobal('fetch', fetchMock)

    const spoken = synthesizeSpeechWithRetry(utterance)
    await vi.advanceTimersByTimeAsync(1000)

    expect(await (await spoken).text()).toBe('spoken')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits as long as OpenRouter asked before asking again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited('5'))
      .mockResolvedValue(audioResponse())
    vi.stubGlobal('fetch', fetchMock)

    const spoken = synthesizeSpeechWithRetry(utterance)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await spoken
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off further with each attempt when no wait is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rateLimited()))
    const waits: number[] = []

    const spoken = synthesizeSpeechWithRetry({
      ...utterance,
      onRetry: (notice) => waits.push(notice.waitMs),
    }).catch(() => null)
    await vi.advanceTimersByTimeAsync(120000)
    await spoken

    // One, two, four then eight seconds, each jittered down by up to half, so
    // several utterances limited together do not all come back at once.
    expect(waits).toHaveLength(4)
    waits.forEach((wait, index) => {
      const backoff = 1000 * 2 ** index
      expect(wait).toBeGreaterThanOrEqual(backoff / 2)
      expect(wait).toBeLessThanOrEqual(backoff)
    })
  })

  it('reports each wait so the view can show it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(rateLimited('2')).mockResolvedValue(audioResponse())
    )
    const notices: SpeechRetryNotice[] = []

    const spoken = synthesizeSpeechWithRetry({ ...utterance, onRetry: (n) => notices.push(n) })
    await vi.advanceTimersByTimeAsync(2000)
    await spoken

    expect(notices).toEqual([{ attempt: 1, attempts: 4, waitMs: 2000 }])
  })

  it('gives up after a bounded number of attempts', async () => {
    const fetchMock = vi.fn(async () => rateLimited('1'))
    vi.stubGlobal('fetch', fetchMock)

    const spoken = synthesizeSpeechWithRetry(utterance)
    const settled = expect(spoken).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(60000)
    await settled

    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('does not ask again when the key itself is refused', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), {
          status: 401,
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(synthesizeSpeechWithRetry(utterance)).rejects.toThrow('No auth credentials found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not ask again when there are no credits to spend', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(synthesizeSpeechWithRetry(utterance)).rejects.toThrow('Insufficient credits')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tries again after a dropped connection', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(audioResponse())
    vi.stubGlobal('fetch', fetchMock)

    const spoken = synthesizeSpeechWithRetry(utterance)
    await vi.advanceTimersByTimeAsync(2000)
    await spoken

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not sit out the wait once the read is cancelled', async () => {
    const fetchMock = vi.fn(async () => rateLimited('30'))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const spoken = synthesizeSpeechWithRetry({ ...utterance, signal: controller.signal })
    const settled = expect(spoken).rejects.toThrow('aborted')

    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await settled
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('TTS model catalogue', () => {
  it('defaults to a model with documented voices', () => {
    expect(findTtsModel(DEFAULT_TTS_MODEL)?.voices).toContain('Eve')
  })

  it('gives no default voice for models that take arbitrary voice ids', () => {
    expect(defaultVoiceForModel('hexgrad/kokoro-82m')).toBe('')
  })

  it('lists no duplicate model ids', () => {
    const ids = TTS_MODELS.map((option) => option.value)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('speechCacheKey', () => {
  it('separates the same line spoken by different voices', () => {
    expect(speechCacheKey('m', 'Eve', 'Breathe.')).not.toBe(speechCacheKey('m', 'Rex', 'Breathe.'))
  })

  it('separates the same line spoken by different models', () => {
    expect(speechCacheKey('a', 'Eve', 'Breathe.')).not.toBe(speechCacheKey('b', 'Eve', 'Breathe.'))
  })

  it('repeats for an unchanged utterance, so a replay costs nothing', () => {
    expect(speechCacheKey('m', 'Eve', 'Breathe.')).toBe(speechCacheKey('m', 'Eve', 'Breathe.'))
  })
})
