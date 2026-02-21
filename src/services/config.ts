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
