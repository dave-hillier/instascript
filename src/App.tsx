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
    <div data-theme={state.isDark ? 'dark' : 'light'}>
      <header role="banner">
        <div>
          <h1>
            <span aria-hidden="true">🔮</span>
            Codex
          </h1>
        </div>
        <nav>
          <button type="button">Environments</button>
          <button type="button">Docs</button>
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
          <h2>What should we code next?</h2>
        </section>
        
        <section>
          <form>
            <textarea 
              placeholder="Describe a task"
              aria-label="Task description"
            />
            <div>
              <div>
                <button aria-label="Attach file" type="button">
                  <Paperclip size={16} />
                </button>
                <select aria-label="Select branch">
                  <option>dave-hillier/refactor-...</option>
                </select>
                <select aria-label="Select base branch">
                  <option>main</option>
                </select>
                <select aria-label="Select context size">
                  <option>4x</option>
                </select>
              </div>
              <div>
                <button aria-label="Voice input" type="button">
                  <Mic size={16} />
                </button>
                <button type="button">Ask</button>
                <button type="submit">Code</button>
              </div>
            </div>
          </form>
        </section>

        <section>
          <div 
            role="tablist"
            aria-label="Task categories"
          >
            <button 
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
                <h3>Suggest refactoring improvements to legacy tool</h3>
                <div>Aug 23 · dave-hillier/refactor-mcp</div>
              </div>
              <div aria-label="4 comments">4</div>
            </article>
            
            <article>
              <div>
                <h3>Replace CON_LINE_WIDTH with constexpr</h3>
                <div>Aug 23 · dave-hillier/old-demo</div>
              </div>
              <div aria-label="Status: Merged">Merged</div>
              <div aria-label="Changes: 14 additions, 13 deletions">+14 -13</div>
            </article>
            
            <article>
              <div>
                <h3>Remove logging macros and update interface</h3>
                <div>Aug 23 · dave-hillier/old-demo</div>
              </div>
              <div aria-label="Changes: 680 additions, 678 deletions">+680 -678</div>
            </article>
            
            <article>
              <div>
                <h3>Suggest codebase improvements</h3>
                <div>Aug 23 · dave-hillier/old-demo</div>
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
