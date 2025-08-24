import { useReducer, useState } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { Sun, Moon, Settings, ArrowLeft } from 'lucide-react'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useAppContext } from './hooks/useAppContext'
import { HomePage } from './pages/HomePage'
import { ScriptPage } from './pages/ScriptPage'
import './App.css'

type ThemeAction = { type: 'TOGGLE_THEME' }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }

type UIState = { 
  isDark: boolean
  showSettingsModal: boolean
}

type UIAction = ThemeAction | ModalAction

const uiReducer = (state: UIState, action: UIAction): UIState => {
  switch (action.type) {
    case 'TOGGLE_THEME':
      return { ...state, isDark: !state.isDark }
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
  const [uiState, uiDispatch] = useReducer(uiReducer, { 
    isDark: true, 
    showSettingsModal: false
  })
  
  const { value: apiKey, setValue: setApiKey } = useLocalStorage<string>('apiKey', '')
  const [tempApiKey, setTempApiKey] = useState('')
  
  const isScriptPage = location.pathname.startsWith('/script/')
  
  // Extract script ID from URL and get script title
  const scriptId = isScriptPage ? location.pathname.split('/script/')[1] : null
  const currentScript = scriptId ? state.scripts.find(s => s.id === scriptId) : null
  const headerTitle = isScriptPage && currentScript ? currentScript.title : 'Hypno'

  const handleSaveSettings = () => {
    if (tempApiKey.trim()) {
      setApiKey(tempApiKey.trim())
    }
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleOpenSettings = () => {
    setTempApiKey(apiKey || '')
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }


  return (
    <div data-theme={uiState.isDark ? 'dark' : 'light'}>
      <header role="banner">
        <div>
          {isScriptPage && (
            <button 
              onClick={() => navigate('/')}
              aria-label="Go back to homepage"
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
            onClick={() => uiDispatch({ type: 'TOGGLE_THEME' })}
            aria-label={uiState.isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            type="button"
          >
            {uiState.isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </nav>
      </header>
      
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/script/:id" element={<ScriptPage />} />
        </Routes>
      </main>

      {uiState.showSettingsModal && (
        <div 
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
            }
          }}
        >
          <div>
            <header>
              <h2 id="settings-title">Settings</h2>
              <button 
                onClick={() => uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })}
                aria-label="Close settings"
                type="button"
              >
                ×
              </button>
            </header>
            <div>
              <div>
                <label htmlFor="api-key">API Key</label>
                <input 
                  type="password" 
                  id="api-key" 
                  placeholder="Enter your API key"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                />
                {apiKey && (
                  <p>API key is currently saved</p>
                )}
              </div>
            </div>
            <footer>
              <button 
                onClick={() => uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })}
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
          </div>
        </div>
      )}
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
