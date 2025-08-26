import { useReducer, useEffect } from 'react'
import type { ReactNode } from 'react'
import type { Script } from '../types/script'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { AppContext } from './AppContext'
import type { AppContextType } from './AppContext'

type AppAction = 
  | { type: 'LOAD_SCRIPTS'; scripts: Script[] }
  | { type: 'ARCHIVE_SCRIPT'; scriptId: string }
  | { type: 'DELETE_SCRIPT'; scriptId: string }
  | { type: 'ADD_SCRIPT'; script: Script }
  | { type: 'UPDATE_SCRIPT'; scriptId: string; updates: Partial<Script> }
  | { type: 'SET_HOVER'; scriptId: string | null }

type AppState = {
  scripts: Script[]
  hoveredScript: string | null
}

const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'LOAD_SCRIPTS':
      return { ...state, scripts: action.scripts }
    case 'ARCHIVE_SCRIPT':
      return {
        ...state,
        scripts: state.scripts.map(script =>
          script.id === action.scriptId
            ? { ...script, isArchived: !script.isArchived }
            : script
        )
      }
    case 'DELETE_SCRIPT':
      return {
        ...state,
        scripts: state.scripts.filter(script => script.id !== action.scriptId)
      }
    case 'ADD_SCRIPT':
      return {
        ...state,
        scripts: [...state.scripts, action.script]
      }
    case 'UPDATE_SCRIPT':
      return {
        ...state,
        scripts: state.scripts.map(script =>
          script.id === action.scriptId
            ? { ...script, ...action.updates }
            : script
        )
      }
    case 'SET_HOVER':
      return { ...state, hoveredScript: action.scriptId }
    default:
      return state
  }
}


type AppProviderProps = {
  children: ReactNode
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [state, dispatch] = useReducer(appReducer, {
    scripts: [],
    hoveredScript: null
  })

  const { value: storedScripts, setValue: setStoredScripts, isLoaded } = useLocalStorage<Script[]>('scripts', [])

  // Load initial scripts from localStorage (only once)
  useEffect(() => {
    if (isLoaded && state.scripts.length === 0) {
      if (storedScripts && storedScripts.length > 0) {
        dispatch({ type: 'LOAD_SCRIPTS', scripts: storedScripts })
      }
      // No longer loading mock scripts - app starts with empty script list
    }
  }, [isLoaded]) // Only depend on isLoaded

  // Save scripts to localStorage when state changes (but not on initial load)
  useEffect(() => {
    if (isLoaded && state.scripts.length > 0) {
      // Only save if the scripts have actually changed from what's stored
      const scriptsChanged = JSON.stringify(state.scripts) !== JSON.stringify(storedScripts)
      if (scriptsChanged) {
        setStoredScripts(state.scripts)
      }
    }
  }, [state.scripts, isLoaded]) // Remove setStoredScripts and storedScripts from deps

  // Only compute filtered scripts if we have scripts loaded
  const activeScripts = state.scripts.filter(script => !script.isArchived)
  const archivedScripts = state.scripts.filter(script => script.isArchived)

  const contextValue: AppContextType = {
    state,
    dispatch,
    activeScripts,
    archivedScripts
  }

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  )
}