import { createContext } from 'react'
import type { RegenerationState, RegenerationAction } from '../types/regeneration'

export type RegenerationContextType = {
  state: RegenerationState
  dispatch: (action: RegenerationAction) => void
}

export const RegenerationContext = createContext<RegenerationContextType | undefined>(undefined)