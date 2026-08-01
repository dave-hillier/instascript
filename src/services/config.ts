export type APIProvider = 'openai' | 'openrouter' | 'mock'

// Not every request deserves the same model. Writing a script is the job the
// expensive model is chosen for; the small background jobs around it —
// suggesting tags for an imported example, tidying a plain-text import into
// markdown — are mechanical, and a small cheap model does them faster and for
// a fraction of the price. Each role has its own model setting.
export type ModelRole = 'generation' | 'utility'

export interface AppConfig {
  apiKey: string | null
  apiProvider: APIProvider
  model: string
  utilityModel: string
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

// The model each role falls back to per provider. The utility defaults are
// the cheapest capable model on each provider, since the utility role only
// ever handles short, well-specified jobs.
export const DEFAULT_MODELS: Record<APIProvider, Record<ModelRole, string>> = {
  openai: { generation: 'gpt-5', utility: 'gpt-5-nano' },
  openrouter: { generation: 'x-ai/grok-4.5', utility: 'x-ai/grok-3-mini' },
  mock: { generation: 'gpt-5', utility: 'gpt-5-nano' }
}

export function getDefaultModel(provider: APIProvider, role: ModelRole): string {
  return DEFAULT_MODELS[provider][role]
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

export function getUtilityModel(): string {
  const fallback = getDefaultModel(getApiProvider(), 'utility')
  const stored = readSetting<string>('utilityModel', fallback)
  return typeof stored === 'string' && stored.trim() ? stored.trim() : fallback
}

export function setUtilityModel(model: string): void {
  writeSetting('utilityModel', model)
}

export function getModelForRole(role: ModelRole): string {
  return role === 'utility' ? getUtilityModel() : getModel()
}

// Whether imports may call the utility model to suggest tags and tidy plain
// text into markdown. On by default: the jobs are cheap and only run on an
// import, and they fall back to the plain import when no provider is
// configured. Switching it off keeps imports entirely offline.
export function isImportAssistEnabled(): boolean {
  return readSetting<boolean>('importAssist', true) !== false
}

export function setImportAssistEnabled(enabled: boolean): void {
  writeSetting('importAssist', enabled)
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

// Whether the optional briefing stage (story 1.10) runs between the brief and
// the generation: one request asks what the brief leaves open, and the
// answers are folded back into it. Off by default — pressing generate should
// still generate — and switched on from the composer itself.
export function isBriefingStageEnabled(): boolean {
  return readSetting<boolean>('briefingStage', false) === true
}

export function setBriefingStageEnabled(enabled: boolean): void {
  writeSetting('briefingStage', enabled)
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
    model: getModel(),
    utilityModel: getUtilityModel()
  }
}

export function canUseOpenAI(config: AppConfig): boolean {
  return config.apiProvider === 'openai' && !!config.apiKey
}

export function canUseOpenRouter(config: AppConfig): boolean {
  return config.apiProvider === 'openrouter' && !!config.apiKey
}
