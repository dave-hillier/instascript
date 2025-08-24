import { useReducer, useState } from 'react'
import { Sun, Moon, Paperclip, Mic, Settings } from 'lucide-react'
import { useLocalStorage } from './hooks/useLocalStorage'
import './App.css'

type ThemeAction = { type: 'TOGGLE_THEME' }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }
type TabAction = { type: 'SET_ACTIVE_TAB'; tab: 'tasks' | 'archive' }

type AppState = { 
  isDark: boolean
  showSettingsModal: boolean
  activeTab: 'tasks' | 'archive'
}

type Action = ThemeAction | ModalAction | TabAction

const appReducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'TOGGLE_THEME':
      return { ...state, isDark: !state.isDark }
    case 'TOGGLE_SETTINGS_MODAL':
      return { ...state, showSettingsModal: !state.showSettingsModal }
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab }
    default:
      return state
  }
}

function App() {
  const [state, dispatch] = useReducer(appReducer, { 
    isDark: true, 
    showSettingsModal: false,
    activeTab: 'tasks' 
  })
  
  const { value: apiKey, setValue: setApiKey } = useLocalStorage<string>('apiKey', '')
  const [tempApiKey, setTempApiKey] = useState('')

  const handleSaveSettings = () => {
    if (tempApiKey.trim()) {
      setApiKey(tempApiKey.trim())
    }
    dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  const handleOpenSettings = () => {
    setTempApiKey(apiKey || '')
    dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
  }

  return (
    <div className={`app ${state.isDark ? 'dark' : 'light'}`}>
      <header role="banner">
        <div className="header-left">
          <div className="logo-container">
            <div className="logo-icon" aria-hidden="true"></div>
            <span className="logo-text">Codex</span>
          </div>
        </div>
        <nav className="header-right" role="navigation">
          <button className="nav-button" type="button">Environments</button>
          <button className="nav-button" type="button">Docs</button>
          <button 
            className="nav-button"
            onClick={handleOpenSettings}
            aria-label="Open settings"
            type="button"
          >
            <Settings size={18} />
          </button>
          <button 
            className="theme-toggle"
            onClick={() => dispatch({ type: 'TOGGLE_THEME' })}
            aria-label={state.isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            type="button"
          >
            {state.isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </nav>
      </header>
      
      <main role="main">
        <section className="hero-section">
          <h1>What should we code next?</h1>
        </section>
        
        <section className="input-section">
          <div className="input-wrapper">
            <textarea 
              className="task-input"
              placeholder="Describe a task"
              aria-label="Task description"
            />
            <div className="input-controls">
              <div className="left-controls">
                <button className="control-button" aria-label="Attach file" type="button">
                  <Paperclip size={16} />
                </button>
                <select className="branch-select" aria-label="Select branch">
                  <option>dave-hillier/refactor-...</option>
                </select>
                <select className="branch-select" aria-label="Select base branch">
                  <option>main</option>
                </select>
                <select className="context-select" aria-label="Select context size">
                  <option>4x</option>
                </select>
              </div>
              <div className="right-controls">
                <button className="control-button" aria-label="Voice input" type="button">
                  <Mic size={16} />
                </button>
                <button className="ask-button" type="button">Ask</button>
                <button className="code-button" type="button">Code</button>
              </div>
            </div>
          </div>
        </section>

        <section className="tabs-section">
          <div 
            className="tabs"
            role="tablist"
            aria-label="Task categories"
          >
            <button 
              className={`tab ${state.activeTab === 'tasks' ? 'active' : ''}`}
              role="tab"
              aria-selected={state.activeTab === 'tasks'}
              aria-controls="tasks-panel"
              id="tasks-tab"
              onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'tasks' })}
              type="button"
            >
              Tasks
            </button>
            <button 
              className={`tab ${state.activeTab === 'archive' ? 'active' : ''}`}
              role="tab"
              aria-selected={state.activeTab === 'archive'}
              aria-controls="archive-panel"
              id="archive-tab"
              onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'archive' })}
              type="button"
            >
              Archive
            </button>
          </div>
        </section>

        <section 
          className="task-section"
          role="tabpanel"
          id={`${state.activeTab}-panel`}
          aria-labelledby={`${state.activeTab}-tab`}
        >
          <div className="task-list">
            <article className="task-item">
              <div className="task-content">
                <h3 className="task-title">Suggest refactoring improvements to legacy tool</h3>
                <div className="task-meta">Aug 23 · dave-hillier/refactor-mcp</div>
              </div>
              <div className="task-badge" aria-label="4 comments">4</div>
            </article>
            
            <article className="task-item">
              <div className="task-content">
                <h3 className="task-title">Replace CON_LINE_WIDTH with constexpr</h3>
                <div className="task-meta">Aug 23 · dave-hillier/old-demo</div>
              </div>
              <div className="task-status merged" aria-label="Status: Merged">Merged</div>
              <div className="task-changes" aria-label="Changes: 14 additions, 13 deletions">+14 -13</div>
            </article>
            
            <article className="task-item">
              <div className="task-content">
                <h3 className="task-title">Remove logging macros and update interface</h3>
                <div className="task-meta">Aug 23 · dave-hillier/old-demo</div>
              </div>
              <div className="task-changes positive" aria-label="Changes: 680 additions, 678 deletions">+680 -678</div>
            </article>
            
            <article className="task-item">
              <div className="task-content">
                <h3 className="task-title">Suggest codebase improvements</h3>
                <div className="task-meta">Aug 23 · dave-hillier/old-demo</div>
              </div>
              <div className="task-badge" aria-label="4 comments">4</div>
            </article>
          </div>
        </section>
      </main>

      {state.showSettingsModal && (
        <div 
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
            }
          }}
        >
          <div className="modal-content">
            <header className="modal-header">
              <h2 id="settings-title">Settings</h2>
              <button 
                className="modal-close"
                onClick={() => dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })}
                aria-label="Close settings"
                type="button"
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="api-key">API Key</label>
                <input 
                  type="password" 
                  id="api-key" 
                  className="form-input"
                  placeholder="Enter your API key"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                />
                {apiKey && (
                  <p className="form-hint">API key is currently saved</p>
                )}
              </div>
            </div>
            <footer className="modal-footer">
              <button 
                className="button secondary"
                onClick={() => dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })}
                type="button"
              >
                Cancel
              </button>
              <button 
                className="button primary" 
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

export default App
