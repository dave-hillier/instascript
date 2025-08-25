import { useReducer, useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { Sun, Moon, Monitor, Settings, ArrowLeft } from 'lucide-react'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useAppContext } from './hooks/useAppContext'
import { HomePage } from './pages/HomePage'
import { ScriptPage } from './pages/ScriptPage'
import './App.css'

type Theme = 'light' | 'dark' | 'system'

type ThemeAction = { type: 'CYCLE_THEME' }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }

type UIState = { 
  theme: Theme
  showSettingsModal: boolean
}

type UIAction = ThemeAction | ModalAction

const uiReducer = (state: UIState, action: UIAction): UIState => {
  switch (action.type) {
    case 'CYCLE_THEME': {
      const themeOrder: Theme[] = ['light', 'dark', 'system']
      const currentIndex = themeOrder.indexOf(state.theme)
      const nextIndex = (currentIndex + 1) % themeOrder.length
      return { ...state, theme: themeOrder[nextIndex] }
    }
    case 'TOGGLE_SETTINGS_MODAL':
      return { ...state, showSettingsModal: !state.showSettingsModal }
    default:
      return state
  }
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { state } = useAppContext()
  const modalRef = useRef<HTMLDialogElement>(null)
  
  const { value: savedTheme, setValue: setSavedTheme } = useLocalStorage<Theme>('theme', 'system')
  const [uiState, uiDispatch] = useReducer(uiReducer, { 
    theme: savedTheme || 'system', 
    showSettingsModal: false
  })
  
  const { value: apiKey, setValue: setApiKey } = useLocalStorage<string>('apiKey', '')
  const [tempApiKey, setTempApiKey] = useState('')
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

  // Save theme preference when it changes (only if different from saved)
  useEffect(() => {
    if (uiState.theme !== savedTheme) {
      setSavedTheme(uiState.theme)
    }
  }, [uiState.theme, savedTheme, setSavedTheme])

  // Determine effective theme (resolve 'system' to actual theme)
  const effectiveTheme = uiState.theme === 'system' 
    ? (systemPrefersDark ? 'dark' : 'light')
    : uiState.theme

  const isScriptPage = location.pathname.startsWith('/script/')
  
  // Extract script ID from URL and get script title
  const scriptId = isScriptPage ? location.pathname.split('/script/')[1] : null
  const currentScript = scriptId ? state.scripts.find(s => s.id === scriptId) : null
  const headerTitle = isScriptPage && currentScript ? currentScript.title : 'Hypno'

  const handleSaveSettings = () => {
    if (tempApiKey.trim()) {
      setApiKey(tempApiKey.trim())
    }
    modalRef.current?.close()
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleOpenSettings = () => {
    setTempApiKey(apiKey || '')
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleCloseModal = () => {
    modalRef.current?.close()
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  // Open/close modal based on state
  useEffect(() => {
    if (uiState.showSettingsModal) {
      modalRef.current?.showModal()
    } else {
      modalRef.current?.close()
    }
  }, [uiState.showSettingsModal])


  return (
    <div data-theme={effectiveTheme}>
      <header role="banner">
        <div>
          {isScriptPage && (
            <button 
              onClick={() => navigate(-1)}
              aria-label="Go back"
              type="button"
              style={{ marginRight: '1rem' }}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h1>
            {!isScriptPage && <span aria-hidden="true">🔮</span>}
            {headerTitle}
          </h1>
        </div>
        <nav>
          <button 
            onClick={handleOpenSettings}
            aria-label="Open settings"
            type="button"
          >
            <Settings size={18} />
          </button>
          <button 
            onClick={() => uiDispatch({ type: 'CYCLE_THEME' })}
            aria-label={`Theme: ${uiState.theme}. Click to switch to ${uiState.theme === 'light' ? 'dark' : uiState.theme === 'dark' ? 'system' : 'light'} mode`}
            type="button"
          >
            {uiState.theme === 'light' ? <Sun size={18} /> : 
             uiState.theme === 'dark' ? <Moon size={18} /> : 
             <Monitor size={18} />}
          </button>
        </nav>
      </header>
      
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/script/:id" element={<ScriptPage />} />
        </Routes>
      </main>

      <dialog 
        ref={modalRef}
        aria-labelledby="settings-title"
        onClick={(e) => {
          if (e.target === modalRef.current) {
            handleCloseModal()
          }
        }}
      >
        <header>
          <h2 id="settings-title">Settings</h2>
          <button 
            onClick={handleCloseModal}
            aria-label="Close settings"
            type="button"
          >
            ×
          </button>
        </header>
        <form onSubmit={(e) => { e.preventDefault(); handleSaveSettings(); }}>
          <fieldset>
            <legend className="sr-only">API Configuration</legend>
            <label htmlFor="api-key">API Key</label>
            <input 
              type="password" 
              id="api-key" 
              placeholder="Enter your API key"
              value={tempApiKey}
              onChange={(e) => setTempApiKey(e.target.value)}
              aria-describedby={apiKey ? "api-key-status" : undefined}
            />
            {apiKey && (
              <p id="api-key-status" role="status">API key is currently saved</p>
            )}
          </fieldset>
        </form>
        <footer>
          <button 
            onClick={handleCloseModal}
            type="button"
          >
            Cancel
          </button>
          <button 
            onClick={handleSaveSettings}
            type="button"
          >
            Save
          </button>
        </footer>
      </dialog>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  )
}

export default App
