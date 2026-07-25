import { useReducer, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Script } from '../types/script'
import { AppContext } from './AppContext'
import type { AppContextType, AppAction, AppState } from './AppContext'
import { parseScriptFromYamlMarkdown, serializeScriptToYamlMarkdown, migrateScriptsToYamlMarkdown } from '../services/scriptParser'

const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'LOAD_SCRIPTS': {
      // A script still marked 'in-progress' at load time was interrupted
      // (e.g. the page was closed mid-stream): reconcile it to 'draft' and
      // remember it so the script page can offer to resume
      const interruptedScriptIds = action.scripts
        .filter(script => script.status === 'in-progress')
        .map(script => script.id)
      const scripts = action.scripts.map(script =>
        script.status === 'in-progress'
          ? { ...script, status: 'draft' as const }
          : script
      )
      return { ...state, scripts, interruptedScriptIds }
    }
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
        scripts: state.scripts.filter(script => script.id !== action.scriptId),
        interruptedScriptIds: state.interruptedScriptIds.filter(id => id !== action.scriptId)
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
        ),
        // Any explicit status transition means the script is no longer
        // waiting as interrupted
        interruptedScriptIds: action.updates.status !== undefined
          ? state.interruptedScriptIds.filter(id => id !== action.scriptId)
          : state.interruptedScriptIds
      }
    case 'SET_HOVER':
      return { ...state, hoveredScript: action.scriptId }
    case 'CLEAR_SCRIPTS':
      return { ...state, scripts: [], interruptedScriptIds: [] }
    default:
      return state
  }
}


type AppProviderProps = {
  children: ReactNode
}

const getStoredScripts = (): Script[] => {
  try {
    // Check for old format and migrate if needed
    const oldItem = window.localStorage.getItem('scripts')
    if (oldItem) {
      // Migrate from old format
      const oldScripts = JSON.parse(oldItem)
      const migrated = migrateScriptsToYamlMarkdown(oldScripts)
      
      // Save in new format
      migrated.forEach((yamlContent, key) => {
        window.localStorage.setItem(key, yamlContent)
      })
      
      // Remove old format
      window.localStorage.removeItem('scripts')
      
      // Return migrated data
      return oldScripts
    }
    
    // Load from new format
    const scripts: Script[] = []
    const keys = Object.keys(window.localStorage)
    
    for (const key of keys) {
      if (key.startsWith('script_')) {
        const yamlContent = window.localStorage.getItem(key)
        if (yamlContent) {
          const parsed = parseScriptFromYamlMarkdown(yamlContent)
          if (parsed) {
            scripts.push(parsed)
          }
        }
      }
    }
    
    return scripts
  } catch (error) {
    console.warn('Error loading scripts from localStorage:', error)
    return []
  }
}

const setStoredScripts = (scripts: Script[]) => {
  try {
    // Clear old script keys
    const keys = Object.keys(window.localStorage)
    for (const key of keys) {
      if (key.startsWith('script_')) {
        window.localStorage.removeItem(key)
      }
    }
    
    // Save each script in new format
    for (const script of scripts) {
      const key = `script_${script.id}`
      const yamlContent = serializeScriptToYamlMarkdown(script)
      window.localStorage.setItem(key, yamlContent)
    }
  } catch (error) {
    console.error('Error saving scripts to localStorage:', error)
  }
}

export const AppProvider = ({ children }: AppProviderProps) => {
  const [state, dispatch] = useReducer(appReducer, {
    scripts: [],
    hoveredScript: null,
    interruptedScriptIds: []
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
      setStoredScripts(state.scripts)
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