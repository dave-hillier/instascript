import { useReducer, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Script } from '../types/script'
import { AppContext } from './AppContext'
import type { AppContextType } from './AppContext'

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
    case 'CLEAR_SCRIPTS':
      return { ...state, scripts: [] }
    default:
      return state
  }
}


type AppProviderProps = {
  children: ReactNode
}

const getStoredScripts = (): Script[] => {
  try {
    const item = window.localStorage.getItem('scripts')
    return item ? JSON.parse(item) : []
  } catch (error) {
    console.warn('Error loading scripts from localStorage:', error)
    return []
  }
}

const setStoredScripts = (scripts: Script[]) => {
  try {
    window.localStorage.setItem('scripts', JSON.stringify(scripts))
  } catch (error) {
    console.error('Error saving scripts to localStorage:', error)
  }
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [state, dispatch] = useReducer(appReducer, {
    scripts: [],
    hoveredScript: null
  })

  const [isLoaded, setIsLoaded] = useState(false)

  // Load initial scripts from localStorage (only once)
  useEffect(() => {
    const stored = getStoredScripts()
    if (stored.length > 0) {
      dispatch({ type: 'LOAD_SCRIPTS', scripts: stored })
    }
    setIsLoaded(true)
  }, [])

  // Save scripts to localStorage when state changes
  useEffect(() => {
    if (isLoaded) {
      if (state.scripts.length > 0) {
        setStoredScripts(state.scripts)
      } else {
        // If no scripts, clear localStorage
        localStorage.removeItem('scripts')
      }
    }
  }, [state.scripts, isLoaded])

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