// Text-to-speech through OpenRouter (story 4.5).
//
// OpenRouter exposes TTS on its own OpenAI-compatible endpoint —
// POST /api/v1/audio/speech — which answers with raw audio bytes rather than
// JSON, so it does not go through the `openai` client used for script
// generation. Errors come back as JSON with a non-2xx status.

const SPEECH_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech'

export interface TtsModelOption {
  value: string
  label: string
  // Voice identifiers, where the model documents a fixed set. Models that
  // accept arbitrary voice ids (cloned voices, provider catalogues) leave this
  // undefined and get a free-text voice field instead — inventing names for
  // them would only produce failed requests.
  voices?: string[]
  maxCharacters?: number
}

export const TTS_MODELS: TtsModelOption[] = [
  {
    value: 'x-ai/grok-voice-tts-1.0',
    label: 'Grok Voice TTS 1.0',
    voices: ['Eve', 'Ara', 'Rex', 'Sal', 'Leo'],
    maxCharacters: 15000,
  },
  { value: 'microsoft/mai-voice-2', label: 'Microsoft MAI-Voice-2' },
  { value: 'microsoft/mai-voice-2-flash', label: 'Microsoft MAI-Voice-2 Flash' },
  { value: 'google/gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS' },
  { value: 'deepgram/aura-2', label: 'Deepgram Aura-2' },
  { value: 'minimax/speech-2.8-hd', label: 'MiniMax Speech 2.8 HD' },
  { value: 'qwen/qwen-audio-3.0-tts-plus', label: 'Qwen-Audio-3.0-TTS Plus' },
  { value: 'hexgrad/kokoro-82m', label: 'Kokoro 82M' },
  { value: 'mistralai/voxtral-mini-tts-2603', label: 'Voxtral Mini TTS' },
]

export const DEFAULT_TTS_MODEL = 'x-ai/grok-voice-tts-1.0'
export const DEFAULT_TTS_VOICE = 'Eve'

export function findTtsModel(model: string): TtsModelOption | undefined {
  return TTS_MODELS.find((option) => option.value === model)
}

// The voice a model should start on: its first documented voice, or nothing
// for models that take arbitrary voice ids.
export function defaultVoiceForModel(model: string): string {
  return findTtsModel(model)?.voices?.[0] ?? ''
}

export interface SynthesisRequest {
  apiKey: string
  model: string
  voice: string
  text: string
  signal?: AbortSignal
}

async function describeFailure(response: Response): Promise<string> {
  let detail = ''
  try {
    const body = await response.json()
    detail = body?.error?.message ?? body?.message ?? ''
  } catch {
    detail = ''
  }
  if (detail) return detail
  return `Speech request failed (${response.status} ${response.statusText})`.trim()
}

// A rejected request, carrying what the retry policy needs to decide: which
// status came back, and how long OpenRouter asked us to wait.
export class SpeechRequestFailed extends Error {
  readonly status: number
  readonly retryAfterMs: number | null

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message)
    this.name = 'SpeechRequestFailed'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

// Retry-After is either a number of seconds or an HTTP date; OpenRouter sends
// it with 429 and 503, and asks that it be honoured before trying again.
//
// From a browser it is usually invisible: the endpoint's
// Access-Control-Expose-Headers lists only X-Generation-Id, X-Provider-Name
// and cf-ray, and Retry-After is not CORS-safelisted, so fetch reads null for
// it. It is honoured when present all the same — the backoff ladder below is
// what actually paces retries here.
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

// One request, one utterance. Callers chunk the script and cache the result;
// this function stays a thin, testable wrapper over the HTTP call.
export async function synthesizeSpeech({
  apiKey,
  model,
  voice,
  text,
  signal,
}: SynthesisRequest): Promise<Blob> {
  const body: Record<string, unknown> = {
    model,
    input: text,
    response_format: 'mp3',
  }
  // Voice is required by the endpoint for models with a fixed catalogue, but
  // omitting it lets a model that only supports its own default still work.
  if (voice) body.voice = voice

  const response = await fetch(SPEECH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new SpeechRequestFailed(
      await describeFailure(response),
      response.status,
      parseRetryAfterMs(response.headers.get('Retry-After'))
    )
  }

  return response.blob()
}

// What OpenRouter documents as worth trying again: rate limiting, a request
// that timed out, and a provider that was briefly unavailable or answered
// badly. Everything else — a rejected key, an empty balance, an unknown model
// — would fail identically however many times it were asked.
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503])
// One, two, four then eight seconds: without a readable Retry-After the ladder
// is guesswork, so it is long enough to outlast a short burst of limiting and
// short enough that a genuinely stuck request still fails while the listener
// is watching. Utterances already fetched stay cached, so a read or export
// that does give up resumes without paying for them again.
const MAX_RETRIES = 4
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

export interface SpeechRetryNotice {
  // Which retry is about to be waited out, and out of how many.
  attempt: number
  attempts: number
  waitMs: number
}

export interface RetryingSynthesisRequest extends SynthesisRequest {
  // Called before each wait, so a long read or export can show that it is
  // waiting rather than stalled.
  onRetry?: (notice: SpeechRetryNotice) => void
}

function abortError(): Error {
  const error = new Error('Speech request aborted')
  error.name = 'AbortError'
  return error
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  if (error instanceof SpeechRequestFailed) return RETRYABLE_STATUSES.has(error.status)
  // A fetch that never reached OpenRouter — a dropped connection, a network
  // that came back a moment later — rejects with a plain TypeError.
  return error instanceof TypeError
}

// Honour what the server asked for; otherwise back off exponentially. The
// jitter matters because utterances are fetched several at a time: without it
// they would all come back at the same instant and be limited together again.
function retryDelayMs(error: unknown, retry: number): number {
  if (error instanceof SpeechRequestFailed && error.retryAfterMs !== null) {
    return Math.min(MAX_BACKOFF_MS, error.retryAfterMs)
  }
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** retry)
  return Math.round(backoff / 2 + Math.random() * (backoff / 2))
}

// A wait that a cancelled export does not have to sit through.
function wait(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// One utterance, asked for again when OpenRouter says it is worth asking
// again. A long script is a long run of requests, and a single rate limit
// part-way through should cost a pause rather than the whole read or
// recording.
export async function synthesizeSpeechWithRetry({
  onRetry,
  ...request
}: RetryingSynthesisRequest): Promise<Blob> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await synthesizeSpeech(request)
    } catch (error) {
      if (retry >= MAX_RETRIES || !isRetryable(error)) throw error
      const waitMs = retryDelayMs(error, retry)
      onRetry?.({ attempt: retry + 1, attempts: MAX_RETRIES, waitMs })
      await wait(waitMs, request.signal)
    }
  }
}
