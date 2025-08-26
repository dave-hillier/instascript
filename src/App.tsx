import { useReducer, useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { Settings, ArrowLeft, Bell } from 'lucide-react'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useAppContext } from './hooks/useAppContext'
import { useJobQueue } from './hooks/useJobQueue'
import { SettingsModal } from './components/SettingsModal'
import { HomePage } from './pages/HomePage'
import { ScriptPage } from './pages/ScriptPage'
import './App.css'

type Theme = 'light' | 'dark' | 'system'

type ThemeAction = { type: 'SET_THEME'; theme: Theme }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }

type UIState = { 
  theme: Theme
  showSettingsModal: boolean
}

type UIAction = ThemeAction | ModalAction

// Notification Bell Component
function NotificationBell() {
  const { state, retryJob, removeJob, clearCompletedJobs } = useJobQueue()
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLElement>(null)
  
  const activeJobs = state.jobs.filter(job => 
    job.status === 'queued' || job.status === 'processing'
  )
  const completedJobs = state.jobs.filter(job => job.status === 'completed')
  const failedJobs = state.jobs.filter(job => job.status === 'failed')
  const totalActiveJobs = activeJobs.length
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false)
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  
  const formatJobTitle = (job: { type: string; title?: string; sectionTitle?: string }) => {
    if (job.type === 'generate-script') {
      return job.title || 'Generate Script'
    }
    return `Regenerate ${job.sectionTitle || 'Section'}`
  }
  
  return (
    <aside 
      className="notification-bell" 
      ref={dropdownRef}
      aria-label="Job notifications"
    >
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        aria-label={`Notifications (${totalActiveJobs} active jobs)`}
        aria-expanded={showDropdown}
        aria-haspopup="true"
        type="button"
      >
        <Bell size={18} />
        {totalActiveJobs > 0 && (
          <span
            className="notification-badge"
            aria-hidden="true"
          >
            {totalActiveJobs}
          </span>
        )}
      </button>
      
      {showDropdown && (
        <menu aria-label="Job queue status">
          <header>
            <h3>Script Jobs</h3>
          </header>
          
          {state.jobs.length === 0 ? (
            <div role="status">No jobs yet</div>
          ) : (
            <ul role="list">
              {[...activeJobs, ...completedJobs, ...failedJobs].map(job => (
                <li key={job.id} role="listitem">
                  <span 
                    className={`status-${job.status}`}
                    aria-label={`Status: ${job.status}`}
                  >
                    ●
                  </span>
                  <div>
                    <h4>{formatJobTitle(job)}</h4>
                    <p>
                      {job.status === 'processing' ? 'In progress...' : 
                       job.status === 'completed' ? 'Completed' :
                       job.status === 'failed' ? 'Failed' : 'Queued'}
                      {' • '}
                      <time dateTime={new Date(job.createdAt).toISOString()}>
                        {new Date(job.createdAt).toLocaleTimeString()}
                      </time>
                    </p>
                    {job.error && (
                      <p role="alert">{job.error}</p>
                    )}
                  </div>
                  
                  {job.status === 'failed' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        retryJob(job.id)
                      }}
                      type="button"
                      aria-label={`Retry ${formatJobTitle(job)}`}
                    >
                      Retry
                    </button>
                  )}
                  {(job.status === 'failed' || job.status === 'completed') && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeJob(job.id)
                      }}
                      type="button"
                      aria-label={`Remove ${formatJobTitle(job)}`}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          
          {(completedJobs.length > 0 || failedJobs.length > 0) && (
            <footer>
              <button
                onClick={() => {
                  clearCompletedJobs()
                  setShowDropdown(false)
                }}
                type="button"
                aria-label="Clear all completed and failed jobs"
              >
                Clear completed jobs
              </button>
            </footer>
          )}
        </menu>
      )}
    </aside>
  )
}

const uiReducer = (state: UIState, action: UIAction): UIState => {
  switch (action.type) {
    case 'SET_THEME':
      return { ...state, theme: action.theme }
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
  
  const { value: savedTheme, setValue: setSavedTheme } = useLocalStorage<Theme>('theme', 'system')
  const [uiState, uiDispatch] = useReducer(uiReducer, { 
    theme: savedTheme || 'system', 
    showSettingsModal: false
  })
  
  const { value: apiKey, setValue: setApiKey } = useLocalStorage<string>('OPENAI_API_KEY', '')
  const { value: apiProvider, setValue: setApiProvider } = useLocalStorage<'openai' | 'mock'>('apiProvider', 'mock')
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
  const headerTitle = isScriptPage && currentScript ? currentScript.title : 'InstaScript'

  const handleSaveSettings = (newApiKey: string, newApiProvider: 'openai' | 'mock') => {
    if (newApiKey.trim()) {
      setApiKey(newApiKey.trim())
    }
    setApiProvider(newApiProvider)
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
              onClick={() => navigate(-1)}
              aria-label="Go back"
              type="button"
              style={{ marginRight: '1rem' }}
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
                <span>{currentScript.createdAt} · Generated Markdown</span>
                {currentScript.status && <span> · {currentScript.status}</span>}
                {currentScript.length && <span> · {currentScript.length}</span>}
              </div>
            )}
          </div>
        </div>
        <nav>
          <NotificationBell />
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
          <Route path="/script/:id" element={<ScriptPage />} />
        </Routes>
      </main>

      <SettingsModal
        isOpen={uiState.showSettingsModal}
        onClose={handleCloseModal}
        theme={uiState.theme}
        onThemeChange={handleThemeChange}
        apiKey={apiKey || ''}
        apiProvider={apiProvider || 'mock'}
        onSave={handleSaveSettings}
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
