import { createContext } from 'react'
import type { APIService } from '../services/apiService'
import type { ExampleService } from '../services/exampleService'

export type ServiceContextType = {
  apiService: APIService
  exampleService: ExampleService
}

export const ServiceContext = createContext<ServiceContextType | null>(null)