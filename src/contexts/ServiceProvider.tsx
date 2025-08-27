import { useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { ServiceFactory, type APIProvider } from '../services/serviceFactory'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { ServiceContext } from './ServiceContext'
import type { ServiceContextType } from './ServiceContext'

type ServiceProviderProps = {
  children: ReactNode
}

export function ServiceProvider({ children }: ServiceProviderProps) {
  const { value: apiKey, isLoaded: apiKeyLoaded } = useLocalStorage<string>('OPENAI_API_KEY', '')
  const { value: apiProvider, isLoaded: apiProviderLoaded } = useLocalStorage<APIProvider>('apiProvider', 'mock')
  
  // Create services only once using refs
  const servicesRef = useRef<ServiceContextType | undefined>(undefined)
  
  // Recreate services when provider or apiKey changes (only after localStorage is loaded)
  useEffect(() => {
    if (apiKeyLoaded && apiProviderLoaded) {
      console.debug('Service configuration updated', { provider: apiProvider, hasApiKey: !!apiKey })
      servicesRef.current = {
        scriptService: ServiceFactory.createScriptService(apiProvider || 'mock', apiKey || undefined),
        exampleService: ServiceFactory.createExampleService(apiProvider || 'mock', apiKey || undefined)
      }
    }
  }, [apiProvider, apiKey, apiKeyLoaded, apiProviderLoaded])

  // Initialize services on first render with mock service until localStorage loads
  if (!servicesRef.current) {
    // Use mock service until localStorage values are loaded
    const providerToUse = apiProviderLoaded ? (apiProvider || 'mock') : 'mock'
    const apiKeyToUse = apiKeyLoaded ? (apiKey || undefined) : undefined
    
    servicesRef.current = {
      scriptService: ServiceFactory.createScriptService(providerToUse, apiKeyToUse),
      exampleService: ServiceFactory.createExampleService(providerToUse, apiKeyToUse)
    }
  }
  
  return (
    <ServiceContext.Provider value={servicesRef.current}>
      {children}
    </ServiceContext.Provider>
  )
}

