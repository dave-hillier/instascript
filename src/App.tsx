import { useReducer, useState } from 'react'
import { Sun, Moon, Settings, ArrowUp } from 'lucide-react'
import { useLocalStorage } from './hooks/useLocalStorage'
import './App.css'

type ThemeAction = { type: 'TOGGLE_THEME' }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }
type TabAction = { type: 'SET_ACTIVE_TAB'; tab: 'scripts' | 'archive' }

type AppState = { 
  isDark: boolean
  showSettingsModal: boolean
  activeTab: 'scripts' | 'archive'
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
    activeTab: 'scripts' 
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
    <div data-theme={state.isDark ? 'dark' : 'light'}>
      <header role="banner">
        <div>
          <h1>
            <span aria-hidden="true">🔮</span>
            Hypno
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
            onClick={() => dispatch({ type: 'TOGGLE_THEME' })}
            aria-label={state.isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            type="button"
          >
            {state.isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </nav>
      </header>
      
      <main>
        <section>
          <h2>What script should we generate?</h2>
        </section>
        
        <section>
          <form>
            <textarea 
              placeholder="Describe a script to generate"
              aria-label="Script description"
            />
            <div>
              <div>
              </div>
              <div>
                <button type="submit">
                  <ArrowUp size={24} />
                </button>
              </div>
            </div>
          </form>
        </section>

        <section>
          <div 
            role="tablist"
            aria-label="Script categories"
          >
            <button 
              role="tab"
              aria-selected={state.activeTab === 'scripts'}
              aria-controls="scripts-panel"
              id="scripts-tab"
              onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'scripts' })}
              type="button"
            >
              Scripts
            </button>
            <button 
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
          role="tabpanel"
          id={`${state.activeTab}-panel`}
          aria-labelledby={`${state.activeTab}-tab`}
        >
          <div>
            <article>
              <div>
                <h3>Weekly team standup script</h3>
                <div>Aug 23 · Generated Markdown</div>
              </div>
              <div aria-label="4 comments">4</div>
            </article>
            
            <article>
              <div>
                <h3>Customer onboarding walkthrough</h3>
                <div>Aug 23 · Generated Markdown</div>
              </div>
              <div aria-label="Status: Complete">Complete</div>
              <div aria-label="Script length: 2.5 pages">2.5 pages</div>
            </article>
            
            <article>
              <div>
                <h3>Product demo presentation script</h3>
                <div>Aug 23 · Generated Markdown</div>
              </div>
              <div aria-label="Script length: 8.2 pages">8.2 pages</div>
            </article>
            
            <article>
              <div>
                <h3>Training workshop outline</h3>
                <div>Aug 23 · Generated Markdown</div>
              </div>
              <div aria-label="4 comments">4</div>
            </article>
          </div>
        </section>
      </main>

      {state.showSettingsModal && (
        <div 
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
            }
          }}
        >
          <div>
            <header>
              <h2 id="settings-title">Settings</h2>
              <button 
                onClick={() => dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })}
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
                onClick={() => dispatch({ type: 'TOGGLE_SETTINGS_MODAL' })}
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

export default App
