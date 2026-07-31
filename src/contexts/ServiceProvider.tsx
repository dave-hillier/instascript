import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createScriptService, createExampleService } from '../services/serviceFactory'
import { subscribeToConfig, getConfigRevision } from '../services/configStore'
import { ServiceContext } from './ServiceContext'

type ServiceProviderProps = {
  children: ReactNode
}

export function ServiceProvider({ children }: ServiceProviderProps) {
  // A service reads the provider and key once, when it is constructed. This
  // sits above the settings form, so nothing here re-rendered when a key was
  // saved and the services kept calling the provider chosen at startup —
  // reporting no key for a key that had just been entered. Subscribing to the
  // config rebuilds them against the settings as they now stand.
  useSyncExternalStore(subscribeToConfig, getConfigRevision)

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
