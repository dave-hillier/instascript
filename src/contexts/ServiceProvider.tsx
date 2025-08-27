import { useRef, useEffect, useState } from 'react'
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
  
  // Use state instead of ref to trigger re-renders when services change
  const [services, setServices] = useState<ServiceContextType | undefined>(undefined)
  
  // Create/recreate services when configuration changes
  useEffect(() => {
    console.debug('ServiceProvider useEffect triggered', { 
      apiKeyLoaded, 
      apiProviderLoaded, 
      apiProvider, 
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey?.length 
    })
    
    // Determine which provider and API key to use
    const providerToUse = apiProviderLoaded ? (apiProvider || 'mock') : 'mock'
    const apiKeyToUse = apiKeyLoaded ? (apiKey || undefined) : undefined
    
    console.debug('Creating services with configuration', { 
      provider: providerToUse, 
      hasApiKey: !!apiKeyToUse,
      apiKeyLength: apiKeyToUse?.length,
      apiProviderLoaded,
      apiKeyLoaded
    })
    
    const newServices = {
      scriptService: ServiceFactory.createScriptService(providerToUse, apiKeyToUse),
      exampleService: ServiceFactory.createExampleService(providerToUse, apiKeyToUse)
    }
    
    console.debug('Services created', {
      scriptService: newServices.scriptService.constructor.name,
      exampleService: newServices.exampleService.constructor.name
    })
    
    setServices(newServices)
  }, [apiProvider, apiKey, apiKeyLoaded, apiProviderLoaded])

  // Don't render children until services are created
  if (!services) {
    return null
  }
  
  return (
    <ServiceContext.Provider value={services}>
      {children}
    </ServiceContext.Provider>
  )
}

