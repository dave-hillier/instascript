export type APIProvider = 'openai' | 'mock'

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
    // API key is stored in sessionStorage for security (not persisted across sessions)
    const item = window.sessionStorage.getItem('OPENAI_API_KEY')
    return item ? JSON.parse(item) : null
  } catch (error) {
    console.warn('Error loading API key from sessionStorage:', error)
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

export function createAppConfig(): AppConfig {
  return {
    apiKey: getApiKey(),
    apiProvider: getApiProvider(),
    model: getModel()
  }
}

export function canUseOpenAI(config: AppConfig): boolean {
  return config.apiProvider === 'openai' && !!config.apiKey
}