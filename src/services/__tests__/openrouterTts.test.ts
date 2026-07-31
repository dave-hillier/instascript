import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TTS_MODEL,
  TTS_MODELS,
  defaultVoiceForModel,
  findTtsModel,
  synthesizeSpeech,
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
