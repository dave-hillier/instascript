export type APIProvider = 'openai' | 'openrouter' | 'mock'

export interface AppConfig {
  apiKey: string | null
  apiProvider: APIProvider
  model: string
}

/**
 * Pure configuration getters - no side effects, just data access
 */

export function getApiKey(): string | null {
  try {
    const item = window.sessionStorage.getItem('OPENAI_API_KEY')
    return item ? JSON.parse(item) : null
  } catch (error) {
    console.warn('Error loading API key from sessionStorage:', error)
    return null
  }
}

export function getOpenRouterApiKey(): string | null {
  try {
    const item = window.sessionStorage.getItem('OPENROUTER_API_KEY')
    return item ? JSON.parse(item) : null
  } catch (error) {
    console.warn('Error loading OpenRouter API key from sessionStorage:', error)
    return null
  }
}

export function getApiProvider(): APIProvider {
  try {
    const item = window.localStorage.getItem('apiProvider')
    return item ? JSON.parse(item) : 'mock'
  } catch (error) {
    console.warn('Error loading API provider from localStorage:', error)
    return 'mock'
  }
}

export function getModel(): string {
  try {
    const item = window.localStorage.getItem('model')
    return item ? JSON.parse(item) : 'gpt-5'
  } catch (error) {
    console.warn('Error loading model from localStorage:', error)
    return 'gpt-5'
  }
}

// Which engine reads the script aloud in performance mode (story 4.5):
// the browser's built-in speech synthesis, or an OpenRouter text-to-speech
// model. The browser engine stays the default — it is free and works offline.
export type ReadAloudEngine = 'browser' | 'openrouter'

function readSetting<T>(key: string, fallback: T): T {
  try {
    const item = window.localStorage.getItem(key)
    return item ? (JSON.parse(item) as T) : fallback
  } catch (error) {
    console.warn(`Error loading ${key} from localStorage:`, error)
    return fallback
  }
}

function writeSetting(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn(`Error saving ${key} to localStorage:`, error)
  }
}

export function getReadAloudEngine(): ReadAloudEngine {
  const engine = readSetting<ReadAloudEngine>('readAloudEngine', 'browser')
  return engine === 'openrouter' ? 'openrouter' : 'browser'
}

export function setReadAloudEngine(engine: ReadAloudEngine): void {
  writeSetting('readAloudEngine', engine)
}

export function getReadAloudVoice(engine: ReadAloudEngine, fallback: string): string {
  return readSetting(`readAloudVoice.${engine}`, fallback)
}

export function setReadAloudVoice(engine: ReadAloudEngine, voice: string): void {
  writeSetting(`readAloudVoice.${engine}`, voice)
}

export function getTtsModel(fallback: string): string {
  return readSetting('ttsModel', fallback)
}

export function setTtsModel(model: string): void {
  writeSetting('ttsModel', model)
}

// Whether the optional style-review pass (story 8.5) runs after each full
// generation. Opt-in, since it adds one critique request plus up to two
// section regenerations per run.
export function isReviewPassEnabled(): boolean {
  try {
    const item = window.localStorage.getItem('reviewPass')
    return item ? JSON.parse(item) === true : false
  } catch (error) {
    console.warn('Error loading review pass setting from localStorage:', error)
    return false
  }
}

export function createAppConfig(): AppConfig {
  const provider = getApiProvider()
  return {
    apiKey: provider === 'openrouter' ? getOpenRouterApiKey() : getApiKey(),
    apiProvider: provider,
    model: getModel()
  }
}

export function canUseOpenAI(config: AppConfig): boolean {
  return config.apiProvider === 'openai' && !!config.apiKey
}

export function canUseOpenRouter(config: AppConfig): boolean {
  return config.apiProvider === 'openrouter' && !!config.apiKey
}
