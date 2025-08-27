import { useRef, useEffect, useState } from 'react'
import { Sun, Moon, Monitor, Trash2 } from 'lucide-react'

type Theme = 'light' | 'dark' | 'system'

type Model = 'gpt-5' | 'gpt-5-mini' | 'gpt-5-nano'

type SettingsModalProps = {
  isOpen: boolean
  onClose: () => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  apiKey: string
  apiProvider: 'openai' | 'mock'
  model: Model
  onSave: (apiKey: string, apiProvider: 'openai' | 'mock', model: Model) => void
  onClearConversations: () => void
}

export const SettingsModal = ({
  isOpen,
  onClose,
  theme,
  onThemeChange,
  apiKey,
  apiProvider,
  model,
  onSave,
  onClearConversations
}: SettingsModalProps) => {
  const modalRef = useRef<HTMLDialogElement>(null)
  const [tempApiKey, setTempApiKey] = useState('')
  const [tempApiProvider, setTempApiProvider] = useState<'openai' | 'mock'>(apiProvider || 'mock')
  const [tempModel, setTempModel] = useState<Model>(model || 'gpt-5')

  // Initialize temp values when modal opens
  useEffect(() => {
    if (isOpen) {
      setTempApiKey(apiKey || '')
      setTempApiProvider(apiProvider || 'mock')
      setTempModel(model || 'gpt-5')
    }
  }, [isOpen, apiKey, apiProvider, model])

  // Open/close modal based on isOpen prop
  useEffect(() => {
    if (isOpen) {
      modalRef.current?.showModal()
    } else {
      modalRef.current?.close()
    }
  }, [isOpen])

  const handleSave = () => {
    onSave(tempApiKey.trim(), tempApiProvider, tempModel)
    onClose()
  }

  const handleClose = () => {
    modalRef.current?.close()
    onClose()
  }

  const getThemeIcon = (themeType: Theme) => {
    switch (themeType) {
      case 'light': return <Sun size={16} />
      case 'dark': return <Moon size={16} />
      case 'system': return <Monitor size={16} />
    }
  }

  const getThemeLabel = (themeType: Theme) => {
    switch (themeType) {
      case 'light': return 'Light'
      case 'dark': return 'Dark'
      case 'system': return 'System'
    }
  }

  return (
    <dialog 
      ref={modalRef}
      aria-labelledby="settings-title"
      onClick={(e) => {
        if (e.target === modalRef.current) {
          handleClose()
        }
      }}
    >
      <header>
        <h2 id="settings-title">Settings</h2>
        <button 
          onClick={handleClose}
          aria-label="Close settings"
          type="button"
        >
          ×
        </button>
      </header>
      
      <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
        <fieldset>
          <legend className="sr-only">Theme Settings</legend>
          
          <label htmlFor="theme-selector">Theme</label>
          <div 
            role="group" 
            aria-labelledby="theme-selector" 
            id="theme-options"
          >
            {(['light', 'dark', 'system'] as Theme[]).map((themeType) => (
              <button
                key={themeType}
                type="button"
                onClick={() => onThemeChange(themeType)}
                aria-pressed={theme === themeType}
                className={theme === themeType ? 'active' : ''}
                aria-label={`Set theme to ${getThemeLabel(themeType)}`}
              >
                {getThemeIcon(themeType)}
                <span>{getThemeLabel(themeType)}</span>
              </button>
            ))}
          </div>
        </fieldset>

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

          <label htmlFor="model-selector">Model</label>
          <select 
            id="model-selector"
            value={tempModel}
            onChange={(e) => setTempModel(e.target.value as Model)}
            aria-describedby="model-help"
          >
            <option value="gpt-5">GPT-5</option>
            <option value="gpt-5-mini">GPT-5 Mini</option>
            <option value="gpt-5-nano">GPT-5 Nano</option>
          </select>
          <p id="model-help">
            Choose the model for script generation
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

        <fieldset>
          <legend className="sr-only">Data Management</legend>
          
          <label>Data Management</label>
          <button
            type="button"
            onClick={onClearConversations}
            aria-label="Clear all conversations"
            className="clear-conversations-btn"
          >
            <Trash2 size={16} />
            <span>Clear All Conversations</span>
          </button>
          <p>
            This will permanently delete all conversation history and scripts
          </p>
        </fieldset>
      </form>
      
      <footer>
        <button 
          onClick={handleClose}
          type="button"
        >
          Cancel
        </button>
        <button 
          onClick={handleSave}
          type="button"
        >
          Save
        </button>
      </footer>
    </dialog>
  )
}