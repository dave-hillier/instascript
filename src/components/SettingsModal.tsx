import { useRef, useEffect, useState } from 'react'
import { Sun, Moon, Monitor, Trash2 } from 'lucide-react'
import type { APIProvider } from '../services/config'

type Theme = 'light' | 'dark' | 'system'

const OPENAI_MODELS = [
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
]

const OPENROUTER_MODELS = [
  { value: 'x-ai/grok-3', label: 'Grok 3' },
  { value: 'x-ai/grok-3-mini', label: 'Grok 3 Mini' },
]

type SettingsModalProps = {
  isOpen: boolean
  onClose: () => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  apiKey: string
  openRouterApiKey: string
  apiProvider: APIProvider
  model: string
  onSave: (apiKey: string, openRouterApiKey: string, apiProvider: APIProvider, model: string) => void
  onClearConversations: () => void
}

export const SettingsModal = ({
  isOpen,
  onClose,
  theme,
  onThemeChange,
  apiKey,
  openRouterApiKey,
  apiProvider,
  model,
  onSave,
  onClearConversations
}: SettingsModalProps) => {
  const modalRef = useRef<HTMLDialogElement>(null)
  const [tempApiKey, setTempApiKey] = useState('')
  const [tempOpenRouterApiKey, setTempOpenRouterApiKey] = useState('')
  const [tempApiProvider, setTempApiProvider] = useState<APIProvider>(apiProvider || 'mock')
  const [tempModel, setTempModel] = useState(model || 'gpt-5')
  const [customModel, setCustomModel] = useState('')

  // Initialize temp values when modal opens
  useEffect(() => {
    if (isOpen) {
      setTempApiKey(apiKey || '')
      setTempOpenRouterApiKey(openRouterApiKey || '')
      setTempApiProvider(apiProvider || 'mock')
      setTempModel(model || 'gpt-5')
      setCustomModel('')
    }
  }, [isOpen, apiKey, openRouterApiKey, apiProvider, model])

  // Open/close modal based on isOpen prop
  useEffect(() => {
    if (isOpen) {
      modalRef.current?.showModal()
    } else {
      modalRef.current?.close()
    }
  }, [isOpen])

  const handleSave = () => {
    const finalModel = tempModel === 'custom' ? customModel.trim() : tempModel
    onSave(tempApiKey.trim(), tempOpenRouterApiKey.trim(), tempApiProvider, finalModel)
    onClose()
  }

  const handleClose = () => {
    modalRef.current?.close()
    onClose()
  }

  const handleProviderChange = (provider: APIProvider) => {
    setTempApiProvider(provider)
    if (provider === 'openai') {
      setTempModel('gpt-5')
    } else if (provider === 'openrouter') {
      setTempModel('x-ai/grok-3')
    }
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

  const modelOptions = tempApiProvider === 'openai' ? OPENAI_MODELS : OPENROUTER_MODELS
  const isPresetModel = modelOptions.some(m => m.value === tempModel)

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
            onChange={(e) => handleProviderChange(e.target.value as APIProvider)}
            aria-describedby="api-provider-help"
          >
            <option value="mock">Mock API (for testing)</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
          </select>

          {tempApiProvider !== 'mock' && (
            <>
              <label htmlFor="model-selector">Model</label>
              <select
                id="model-selector"
                value={isPresetModel ? tempModel : 'custom'}
                onChange={(e) => setTempModel(e.target.value)}
                aria-describedby="model-help"
              >
                {modelOptions.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
                {tempApiProvider === 'openrouter' && (
                  <option value="custom">Custom model...</option>
                )}
              </select>

              {tempApiProvider === 'openrouter' && (tempModel === 'custom' || !isPresetModel) && (
                <>
                  <label htmlFor="custom-model">Custom Model ID</label>
                  <input
                    type="text"
                    id="custom-model"
                    placeholder="e.g. x-ai/grok-4, anthropic/claude-sonnet-4"
                    value={customModel || (!isPresetModel && tempModel !== 'custom' ? tempModel : '')}
                    onChange={(e) => {
                      setCustomModel(e.target.value)
                      setTempModel('custom')
                    }}
                    aria-describedby="custom-model-help"
                  />
                  <p id="custom-model-help">
                    Enter any OpenRouter model ID
                  </p>
                </>
              )}

              <p id="model-help">
                Choose the model for script generation
              </p>
            </>
          )}

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

          {tempApiProvider === 'openrouter' && (
            <>
              <label htmlFor="openrouter-api-key">OpenRouter API Key</label>
              <input
                type="password"
                id="openrouter-api-key"
                placeholder="Enter your OpenRouter API key"
                value={tempOpenRouterApiKey}
                onChange={(e) => setTempOpenRouterApiKey(e.target.value)}
                aria-describedby={openRouterApiKey ? "openrouter-key-status" : "openrouter-key-help"}
                required
              />
              <p id="openrouter-key-help">
                Get your API key from openrouter.ai/keys
              </p>
              {openRouterApiKey && (
                <p id="openrouter-key-status" role="status">API key is currently saved</p>
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
