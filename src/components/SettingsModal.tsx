import { useRef, useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

type SettingsModalProps = {
  isOpen: boolean
  onClose: () => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  apiKey: string
  apiProvider: 'openai' | 'mock'
  onSave: (apiKey: string, apiProvider: 'openai' | 'mock') => void
}

export const SettingsModal = ({
  isOpen,
  onClose,
  theme,
  onThemeChange,
  apiKey,
  apiProvider,
  onSave
}: SettingsModalProps) => {
  const modalRef = useRef<HTMLDialogElement>(null)
  const [tempApiKey, setTempApiKey] = useState('')
  const [tempApiProvider, setTempApiProvider] = useState<'openai' | 'mock'>('mock')

  // Initialize temp values when modal opens
  useEffect(() => {
    if (isOpen) {
      setTempApiKey(apiKey || '')
      setTempApiProvider(apiProvider || 'mock')
    }
  }, [isOpen, apiKey, apiProvider])

  // Open/close modal based on isOpen prop
  useEffect(() => {
    if (isOpen) {
      modalRef.current?.showModal()
    } else {
      modalRef.current?.close()
    }
  }, [isOpen])

  const handleSave = () => {
    onSave(tempApiKey.trim(), tempApiProvider)
    onClose()
  }

  const handleClose = () => {
    modalRef.current?.close()
    onClose()
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
          <select 
            id="theme-selector"
            value={theme}
            onChange={(e) => onThemeChange(e.target.value as Theme)}
            aria-describedby="theme-help"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
          <p id="theme-help">
            Choose your preferred color theme or use system settings
          </p>
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