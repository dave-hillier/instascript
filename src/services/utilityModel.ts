import OpenAI from 'openai'
import type {
  UtilityCompletionRequest,
  UtilityModelService
} from './utilityModelService'
import { UTILITY_JOB_LABELS } from './utilityModelService'
import { beginTranscript, toTranscriptMessages } from './debugTranscript'

// Utility jobs run in the background of an import, so they get a ceiling:
// a stalled request must not leave the import spinner up indefinitely.
const REQUEST_TIMEOUT_MS = 90_000

const DEFAULT_MAX_OUTPUT_TOKENS = 4096

// Combines the caller's abort signal with the timeout, and hands back a
// disposer so neither the timer nor the listener outlives the request
function requestSignal(callerSignal: AbortSignal | undefined): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const forward = () => controller.abort()

  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', forward)
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forward)
    }
  }
}

// Both providers speak the OpenAI chat completions API, so one client covers
// them; only the base URL, the token-limit parameter name and the
// reasoning-effort hint differ.
export class OpenAICompatibleUtilityService implements UtilityModelService {
  private client: OpenAI
  private provider: 'openai' | 'openrouter'
  readonly model: string
  readonly isLive = true

  constructor(apiKey: string, provider: 'openai' | 'openrouter', model: string) {
    this.provider = provider
    this.model = model
    this.client = new OpenAI({
      apiKey,
      ...(provider === 'openrouter' ? { baseURL: 'https://openrouter.ai/api/v1' } : {}),
      dangerouslyAllowBrowser: true
    })
  }

  async complete(request: UtilityCompletionRequest): Promise<string> {
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user }
    ]
    const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS

    // OpenAI's newer models take max_completion_tokens and accept a
    // reasoning-effort hint; minimal effort is what makes a small model fast
    // enough for these jobs. OpenRouter normalises on max_tokens.
    const limits = this.provider === 'openai'
      ? {
          max_completion_tokens: maxOutputTokens,
          ...(this.model.startsWith('gpt-5') ? { reasoning_effort: 'minimal' as const } : {})
        }
      : { max_tokens: maxOutputTokens }

    const transcript = beginTranscript({
      provider: this.provider,
      model: this.model,
      label: UTILITY_JOB_LABELS[request.job],
      messages: toTranscriptMessages(messages),
      params: { role: 'utility', ...limits }
    })

    const { signal, dispose } = requestSignal(request.signal)
    try {
      const response = await this.client.chat.completions.create(
        { model: this.model, messages, stream: false, ...limits },
        { signal }
      )
      const text = response.choices[0]?.message?.content ?? ''
      transcript.appendChunk(text)
      transcript.complete()
      return text
    } catch (error) {
      if (request.signal?.aborted) {
        transcript.abort()
        return ''
      }
      transcript.fail(error)
      throw error
    } finally {
      dispose()
    }
  }
}

// Words the mock recognises in a script, so the mock provider produces tags
// that at least relate to what was imported
const MOCK_TAG_VOCABULARY = [
  'relaxation', 'sleep', 'insomnia', 'confidence', 'anxiety', 'stress',
  'focus', 'motivation', 'pain', 'smoking', 'weight', 'breathing',
  'visualisation', 'deepening', 'induction', 'awakening'
]

// Stands in for the utility model when no provider is configured. It never
// claims to be live, so callers treat its output as a placeholder rather than
// as a model's judgement.
export class MockUtilityService implements UtilityModelService {
  readonly model = 'mock-utility'
  readonly isLive = false

  async complete(request: UtilityCompletionRequest): Promise<string> {
    if (request.job === 'tagging') {
      const text = request.user.toLowerCase()
      const matched = MOCK_TAG_VOCABULARY.filter(tag => text.includes(tag)).slice(0, 4)
      return matched.length > 0 ? matched.join(', ') : 'hypnosis'
    }
    // The mock has no way to restructure prose. An empty reply is the signal
    // that nothing can be applied, so the import keeps its original text.
    return ''
  }
}
