import { createContext } from 'react'
import type { ScriptGenerationService } from '../services/scriptGenerationService'
import type { ExampleSearchService } from '../services/exampleSearchService'

export type ServiceContextType = {
  scriptService: ScriptGenerationService
  exampleService: ExampleSearchService
}

export const ServiceContext = createContext<ServiceContextType | null>(null)