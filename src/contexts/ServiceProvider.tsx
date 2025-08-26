import { createContext, useContext, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { APIService } from '../services/apiService'
import { ExampleService } from '../services/exampleService'
import type { APIProvider } from '../services/apiService'
import { useLocalStorage } from '../hooks/useLocalStorage'

type ServiceContextType = {
  apiService: APIService
  exampleService: ExampleService
}

const ServiceContext = createContext<ServiceContextType | null>(null)

type ServiceProviderProps = {
  children: ReactNode
}

export function ServiceProvider({ children }: ServiceProviderProps) {
  const { value: apiKey } = useLocalStorage<string>('apiKey', '')
  const { value: apiProvider } = useLocalStorage<APIProvider>('apiProvider', 'mock')
  
  // Create services only once using refs
  const servicesRef = useRef<ServiceContextType | undefined>(undefined)
  
  if (!servicesRef.current) {
    console.log('Creating service instances')
    servicesRef.current = {
      apiService: new APIService(apiProvider || 'mock', apiKey || undefined),
      exampleService: new ExampleService(apiProvider || 'mock', apiKey || undefined)
    }
  }
  
  // Update service configuration when settings change
  useEffect(() => {
    console.log('Updating service configuration', { provider: apiProvider, hasApiKey: !!apiKey })
    servicesRef.current!.apiService.setProvider(apiProvider || 'mock', apiKey || undefined)
    servicesRef.current!.exampleService.setProvider(apiProvider || 'mock', apiKey || undefined)
  }, [apiProvider, apiKey])
  
  return (
    <ServiceContext.Provider value={servicesRef.current}>
      {children}
    </ServiceContext.Provider>
  )
}

export function useServices(): ServiceContextType {
  const context = useContext(ServiceContext)
  if (!context) {
    throw new Error('useServices must be used within a ServiceProvider')
  }
  return context
}