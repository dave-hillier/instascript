import type { ReactNode } from 'react'
import { ServiceFactory } from '../services/serviceFactory'
import { ServiceContext } from './ServiceContext'

type ServiceProviderProps = {
  children: ReactNode
}

export function ServiceProvider({ children }: ServiceProviderProps) {
  const services = {
    scriptService: ServiceFactory.createScriptService(),
    exampleService: ServiceFactory.createExampleService()
  }
  
  return (
    <ServiceContext.Provider value={services}>
      {children}
    </ServiceContext.Provider>
  )
}

