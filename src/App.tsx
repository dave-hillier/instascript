import { useReducer, useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { Settings, ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { useAppContext } from './hooks/useAppContext'
import { SettingsModal } from './components/SettingsModal'
import { HomePage } from './pages/HomePage'
import { ScriptPage } from './pages/ScriptPage'
import type { APIProvider } from './services/config'
import './App.css'

type Theme = 'light' | 'dark' | 'system'

type ThemeAction = { type: 'SET_THEME'; theme: Theme }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }
type SectionTitlesAction = { type: 'TOGGLE_SECTION_TITLES' }

type UIState = {
  theme: Theme
  showSettingsModal: boolean
  showSectionTitles: boolean
}

type UIAction = ThemeAction | ModalAction | SectionTitlesAction


const uiReducer = (state: UIState, action: UIAction): UIState => {
  switch (action.type) {
    case 'SET_THEME':
      return { ...state, theme: action.theme }
    case 'TOGGLE_SETTINGS_MODAL':
      return { ...state, showSettingsModal: !state.showSettingsModal }
    case 'TOGGLE_SECTION_TITLES':
      return { ...state, showSectionTitles: !state.showSectionTitles }
    default:
      return state
  }
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()

  const [uiState, uiDispatch] = useReducer(uiReducer, {
    theme: (() => {
      try {
        const item = window.localStorage.getItem('theme')
        return item ? JSON.parse(item) : 'system'
      } catch {
        return 'system'
      }
    })(),
    showSettingsModal: false,
    showSectionTitles: (() => {
      try {
        const item = window.localStorage.getItem('showSectionTitles')
        return item ? JSON.parse(item) : true
      } catch {
        return true
      }
    })()
  })

  const [apiKey, setApiKey] = useState(() => {
    try {
      // Migrate API key from localStorage to sessionStorage if present
      const legacyItem = window.localStorage.getItem('OPENAI_API_KEY')
      if (legacyItem) {
        const key = JSON.parse(legacyItem)
        if (key) {
          window.sessionStorage.setItem('OPENAI_API_KEY', JSON.stringify(key))
        }
        window.localStorage.removeItem('OPENAI_API_KEY')
        return key || ''
      }
      // Read from sessionStorage (not persisted across browser sessions)
      const item = window.sessionStorage.getItem('OPENAI_API_KEY')
      return item ? JSON.parse(item) : ''
    } catch {
      return ''
    }
  })

  const [openRouterApiKey, setOpenRouterApiKey] = useState(() => {
    try {
      const item = window.sessionStorage.getItem('OPENROUTER_API_KEY')
      return item ? JSON.parse(item) : ''
    } catch {
      return ''
    }
  })

  const [apiProvider, setApiProvider] = useState<APIProvider>(() => {
    try {
      const item = window.localStorage.getItem('apiProvider')
      return item ? JSON.parse(item) : 'mock'
    } catch {
      return 'mock'
    }
  })

  const [model, setModel] = useState<string>(() => {
    try {
      const item = window.localStorage.getItem('model')
      return item ? JSON.parse(item) : 'gpt-5'
    } catch {
      return 'gpt-5'
    }
  })
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemPrefersDark(e.matches)
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  // Save theme preference when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('theme', JSON.stringify(uiState.theme))
    } catch (error) {
      console.error('Error saving theme to localStorage:', error)
    }
  }, [uiState.theme])

  // Save OpenAI API key to sessionStorage
  useEffect(() => {
    try {
      window.sessionStorage.setItem('OPENAI_API_KEY', JSON.stringify(apiKey))
    } catch (error) {
      console.error('Error saving API key to sessionStorage:', error)
    }
  }, [apiKey])

  // Save OpenRouter API key to sessionStorage
  useEffect(() => {
    try {
      window.sessionStorage.setItem('OPENROUTER_API_KEY', JSON.stringify(openRouterApiKey))
    } catch (error) {
      console.error('Error saving OpenRouter API key to sessionStorage:', error)
    }
  }, [openRouterApiKey])

  // Save API provider when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('apiProvider', JSON.stringify(apiProvider))
    } catch (error) {
      console.error('Error saving API provider to localStorage:', error)
    }
  }, [apiProvider])

  // Save model when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('model', JSON.stringify(model))
    } catch (error) {
      console.error('Error saving model to localStorage:', error)
    }
  }, [model])

  // Save section titles visibility when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('showSectionTitles', JSON.stringify(uiState.showSectionTitles))
    } catch (error) {
      console.error('Error saving section titles visibility to localStorage:', error)
    }
  }, [uiState.showSectionTitles])

  // Determine effective theme (resolve 'system' to actual theme)
  const effectiveTheme = uiState.theme === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : uiState.theme

  const isScriptPage = location.pathname.startsWith('/script/')

  // Extract script ID from URL and get script title
  const scriptId = isScriptPage ? location.pathname.split('/script/')[1] : null
  const currentScript = scriptId ? state.scripts.find(s => s.id === scriptId) : null
  const headerTitle = isScriptPage && currentScript ? currentScript.title : 'InstaScript'


  const handleSaveSettings = (newApiKey: string, newOpenRouterApiKey: string, newApiProvider: APIProvider, newModel: string) => {
    if (newApiKey.trim()) {
      setApiKey(newApiKey.trim())
    }
    if (newOpenRouterApiKey.trim()) {
      setOpenRouterApiKey(newOpenRouterApiKey.trim())
    }
    setApiProvider(newApiProvider)
    setModel(newModel)
  }

  const handleClearConversations = () => {
    if (confirm('Are you sure you want to clear all conversations and scripts? This action cannot be undone.')) {
      // Clear all conversation_* and script_* keys from localStorage
      const keys = Object.keys(localStorage)
      for (const key of keys) {
        if (key.startsWith('conversation_') || key.startsWith('script_')) {
          localStorage.removeItem(key)
        }
      }
      // Also clear old formats if they exist
      localStorage.removeItem('conversations')
      localStorage.removeItem('scripts')
      // Clear scripts from state (they're stored in localStorage via AppProvider)
      dispatch({ type: 'CLEAR_SCRIPTS' })
      // Close the modal
      uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
      // Navigate to home page if currently on a script page
      if (isScriptPage) {
        navigate('/')
      }
    }
  }

  const handleOpenSettings = () => {
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleCloseModal = () => {
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleThemeChange = (newTheme: Theme) => {
    uiDispatch({ type: 'SET_THEME', theme: newTheme })
  }

  return (
    <div data-theme={effectiveTheme}>
      <header role="banner">
        <div>
          {isScriptPage && (
            <button
              onClick={() => navigate('/')}
              aria-label="Go back"
              type="button"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            <h1>
              {headerTitle}
            </h1>
            {isScriptPage && currentScript && (
              <div>
                <span>{currentScript.createdAt}</span>
                {currentScript.provider && currentScript.model && (
                  <span> · {currentScript.provider}/{currentScript.model}</span>
                )}
                {currentScript.status && <span> · {currentScript.status}</span>}
                {currentScript.length && <span> · {currentScript.length}</span>}
              </div>
            )}
          </div>
        </div>
        <nav>
          {isScriptPage && (
            <button
              onClick={() => uiDispatch({ type: 'TOGGLE_SECTION_TITLES' })}
              aria-label={uiState.showSectionTitles ? "Hide section titles" : "Show section titles"}
              type="button"
            >
              {uiState.showSectionTitles ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          )}
          <button
            onClick={handleOpenSettings}
            aria-label="Open settings"
            type="button"
          >
            <Settings size={18} />
          </button>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/script/:id" element={<ScriptPage showSectionTitles={uiState.showSectionTitles} />} />
        </Routes>
      </main>

      <SettingsModal
        isOpen={uiState.showSettingsModal}
        onClose={handleCloseModal}
        theme={uiState.theme}
        onThemeChange={handleThemeChange}
        apiKey={apiKey || ''}
        openRouterApiKey={openRouterApiKey || ''}
        apiProvider={apiProvider || 'mock'}
        model={model || 'gpt-5'}
        onSave={handleSaveSettings}
        onClearConversations={handleClearConversations}
      />
    </div>
  )
}

function App() {
  return (
    <BrowserRouter basename="/instascript">
      <AppContent />
    </BrowserRouter>
  )
}

export default App
