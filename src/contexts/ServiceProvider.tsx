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
  const { value: apiKey } = useLocalStorage<string>('OPENAI_API_KEY', '')
  const { value: apiProvider } = useLocalStorage<APIProvider>('apiProvider', 'mock')
  
  // Create services only once using refs
  const servicesRef = useRef<ServiceContextType | undefined>(undefined)
  
  // Recreate services when provider or apiKey changes
  useEffect(() => {
    console.debug('Service configuration updated', { provider: apiProvider })
    servicesRef.current = {
      scriptService: ServiceFactory.createScriptService(apiProvider || 'mock', apiKey || undefined),
      exampleService: ServiceFactory.createExampleService(apiProvider || 'mock', apiKey || undefined)
    }
  }, [apiProvider, apiKey])

  // Initialize services on first render
  if (!servicesRef.current) {
    servicesRef.current = {
      scriptService: ServiceFactory.createScriptService(apiProvider || 'mock', apiKey || undefined),
      exampleService: ServiceFactory.createExampleService(apiProvider || 'mock', apiKey || undefined)
    }
  }
  
  return (
    <ServiceContext.Provider value={servicesRef.current}>
      {children}
    </ServiceContext.Provider>
  )
}

