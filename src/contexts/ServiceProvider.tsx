import type { ReactNode } from 'react'
import { createScriptService, createExampleService } from '../services/serviceFactory'
import { ServiceContext } from './ServiceContext'

type ServiceProviderProps = {
  children: ReactNode
}

export function ServiceProvider({ children }: ServiceProviderProps) {
  const services = {
    scriptService: createScriptService(),
    exampleService: createExampleService()
  }
  
  return (
    <ServiceContext.Provider value={services}>
      {children}
    </ServiceContext.Provider>
  )
}

