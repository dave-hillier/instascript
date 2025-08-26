import { useReducer, useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { Sun, Moon, Monitor, Settings, ArrowLeft, Bell } from 'lucide-react'
import { useLocalStorage } from './hooks/useLocalStorage'
import { useAppContext } from './hooks/useAppContext'
import { useJobQueue } from './hooks/useJobQueue'
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

// Notification Bell Component
function NotificationBell() {
  const { state, retryJob, removeJob, clearCompletedJobs } = useJobQueue()
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  
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
  
  const formatJobTitle = (job: any) => {
    if (job.type === 'generate-script') {
      return job.title || 'Generate Script'
    }
    return `Regenerate ${job.sectionTitle || 'Section'}`
  }
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'processing': return '#3b82f6'
      case 'completed': return '#10b981'
      case 'failed': return '#ef4444'
      default: return '#6b7280'
    }
  }
  
  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        aria-label={`Notifications (${totalActiveJobs} active jobs)`}
        type="button"
        style={{ position: 'relative' }}
      >
        <Bell size={18} />
        {totalActiveJobs > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-6px',
              right: '-6px',
              background: '#ef4444',
              color: 'white',
              borderRadius: '50%',
              width: '16px',
              height: '16px',
              fontSize: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold'
            }}
            aria-hidden="true"
          >
            {totalActiveJobs}
          </span>
        )}
      </button>
      
      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: '0',
            marginTop: '8px',
            width: '320px',
            maxHeight: '400px',
            overflowY: 'auto',
            background: 'var(--background-color, white)',
            border: '1px solid var(--border-color, #e5e7eb)',
            borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.1)',
            zIndex: 50
          }}
          role="menu"
          aria-label="Job notifications"
        >
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '600' }}>Script Jobs</h3>
          </div>
          
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {state.jobs.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted, #6b7280)' }}>
                No jobs yet
              </div>
            ) : (
              [...activeJobs, ...completedJobs, ...failedJobs].map(job => (
                <div
                  key={job.id}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--border-color, #e5e7eb)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px'
                  }}
                  role="menuitem"
                >
                  <div
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: getStatusColor(job.status),
                      marginTop: '6px',
                      flexShrink: 0
                    }}
                    aria-hidden="true"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>
                      {formatJobTitle(job)}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted, #6b7280)', marginBottom: '4px' }}>
                      {job.status === 'processing' ? 'In progress...' : 
                       job.status === 'completed' ? 'Completed' :
                       job.status === 'failed' ? 'Failed' : 'Queued'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted, #6b7280)' }}>
                      {new Date(job.createdAt).toLocaleTimeString()}
                    </div>
                    {job.error && (
                      <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px' }}>
                        {job.error}
                      </div>
                    )}
                    
                    {/* Action buttons for failed or completed jobs */}
                    {(job.status === 'failed' || job.status === 'completed') && (
                      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                        {job.status === 'failed' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              retryJob(job.id)
                            }}
                            style={{
                              fontSize: '10px',
                              padding: '4px 8px',
                              background: '#3b82f6',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer'
                            }}
                            type="button"
                          >
                            Retry
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeJob(job.id)
                          }}
                          style={{
                            fontSize: '10px',
                            padding: '4px 8px',
                            background: '#6b7280',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer'
                          }}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          
          {(completedJobs.length > 0 || failedJobs.length > 0) && (
            <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-color, #e5e7eb)' }}>
              <button
                onClick={() => {
                  clearCompletedJobs()
                  setShowDropdown(false)
                }}
                style={{
                  fontSize: '12px',
                  color: 'var(--text-muted, #6b7280)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 0',
                  width: '100%',
                  textAlign: 'left'
                }}
                type="button"
              >
                Clear completed jobs
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

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
  
  const { value: apiKey, setValue: setApiKey } = useLocalStorage<string>('OPENAI_API_KEY', '')
  const { value: apiProvider, setValue: setApiProvider } = useLocalStorage<'openai' | 'mock'>('apiProvider', 'mock')
  const [tempApiKey, setTempApiKey] = useState('')
  const [tempApiProvider, setTempApiProvider] = useState<'openai' | 'mock'>('mock')
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

  const handleSaveSettings = () => {
    if (tempApiKey.trim()) {
      setApiKey(tempApiKey.trim())
    }
    setApiProvider(tempApiProvider)
    modalRef.current?.close()
    uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleOpenSettings = () => {
    setTempApiKey(apiKey || '')
    setTempApiProvider(apiProvider || 'mock')
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
          <div>
            <h1>
              {!isScriptPage && <span aria-hidden="true">🔮</span>}
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
            
            <label htmlFor="api-provider">API Provider</label>
            <select 
              id="api-provider"
              value={tempApiProvider}
              onChange={(e) => setTempApiProvider(e.target.value as 'openai' | 'mock')}
              aria-describedby="api-provider-help"
            >
              <option value="mock">Mock API (for testing)</option>
              <option value="openai">OpenAI</option>
            </select>
            <p id="api-provider-help">
              Use Mock API for testing or OpenAI for real script generation
            </p>

            {tempApiProvider === 'openai' && (
              <>
                <label htmlFor="api-key">OpenAI API Key</label>
                <input 
                  type="password" 
                  id="api-key" 
                  placeholder="Enter your OpenAI API key"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                  aria-describedby={apiKey ? "api-key-status" : "api-key-help"}
                  required
                />
                <p id="api-key-help">
                  Get your API key from the OpenAI dashboard
                </p>
                {apiKey && (
                  <p id="api-key-status" role="status">API key is currently saved</p>
                )}
              </>
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
    <BrowserRouter basename="/instascript">
      <AppContent />
    </BrowserRouter>
  )
}

export default App
