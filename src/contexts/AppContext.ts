import { createContext } from 'react'
import type { Script } from '../types/script'

type AppAction = 
  | { type: 'LOAD_SCRIPTS'; scripts: Script[] }
  | { type: 'ARCHIVE_SCRIPT'; scriptId: string }
  | { type: 'DELETE_SCRIPT'; scriptId: string }
  | { type: 'ADD_SCRIPT'; script: Script }
  | { type: 'UPDATE_SCRIPT'; scriptId: string; updates: Partial<Script> }
  | { type: 'SET_HOVER'; scriptId: string | null }
  | { type: 'CLEAR_SCRIPTS' }

type AppState = {
  scripts: Script[]
  hoveredScript: string | null
}

export type AppContextType = {
  state: AppState
  dispatch: (action: AppAction) => void
  activeScripts: Script[]
  archivedScripts: Script[]
}

export const AppContext = createContext<AppContextType | undefined>(undefined)