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
    throw new Error(await describeFailure(response))
  }

  return response.blob()
}
