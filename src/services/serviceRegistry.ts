import { APIService } from './apiService'
import { ExampleService } from './exampleService'
import type { APIProvider } from './apiService'

class ServiceRegistry {
  private static instance: ServiceRegistry
  private apiService: APIService
  private exampleService: ExampleService
  
  private constructor() {
    this.apiService = new APIService('mock')
    this.exampleService = new ExampleService('mock')
    console.log('[ServiceRegistry] Singleton instance created')
  }
  
  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry()
    }
    return ServiceRegistry.instance
  }
  
  getAPIService(): APIService {
    return this.apiService
  }
  
  getExampleService(): ExampleService {
    return this.exampleService
  }
  
  updateProvider(provider: APIProvider, apiKey?: string): void {
    console.log('[ServiceRegistry] Updating provider configuration', { provider, hasApiKey: !!apiKey })
    this.apiService.setProvider(provider, apiKey)
    this.exampleService.setProvider(provider, apiKey)
  }
}

export const serviceRegistry = ServiceRegistry.getInstance()