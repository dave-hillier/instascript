import { useRef, useEffect, useState, useReducer, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { Sun, Moon, Monitor, Trash2, Download, Upload, FolderSync, FolderX, FileText } from 'lucide-react'
import { subscribeToTranscripts, getTranscripts, MAX_TRANSCRIPTS } from '../services/debugTranscript'
import type { APIProvider } from '../services/config'
import { testApiConnection } from '../services/connectionTest'
import type { LibraryImportCounts } from '../services/libraryTransfer'

type Theme = 'light' | 'dark' | 'system'

const OPENAI_MODELS = [
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
]

const OPENROUTER_MODELS = [
  { value: 'x-ai/grok-4.5', label: 'Grok 4.5' },
  { value: 'x-ai/grok-4.3', label: 'Grok 4.3' },
  { value: 'x-ai/grok-4.20', label: 'Grok 4.20' },
  { value: 'x-ai/grok-3', label: 'Grok 3' },
  { value: 'x-ai/grok-3-mini', label: 'Grok 3 Mini' },
]

// Inline outcome of the "Test connection" action (story 5.4)
type ConnectionTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'tested'; ok: boolean; message: string }

type ConnectionTestEvent =
  | { type: 'TEST_STARTED' }
  | { type: 'TEST_COMPLETED'; ok: boolean; message: string }
  | { type: 'TEST_RESET' }

const connectionTestReducer = (
  _state: ConnectionTestState,
  event: ConnectionTestEvent
): ConnectionTestState => {
  switch (event.type) {
    case 'TEST_STARTED':
      return { status: 'testing' }
    case 'TEST_COMPLETED':
      return { status: 'tested', ok: event.ok, message: event.message }
    case 'TEST_RESET':
      return { status: 'idle' }
  }
}

// Inline outcome of library export/import (story 7.2)
type LibraryTransferState =
  | { status: 'idle' }
  | { status: 'exported' }
  | { status: 'imported'; counts: LibraryImportCounts }
  | { status: 'failed'; message: string }

type LibraryTransferEvent =
  | { type: 'EXPORT_COMPLETED' }
  | { type: 'IMPORT_COMPLETED'; counts: LibraryImportCounts }
  | { type: 'TRANSFER_FAILED'; message: string }
  | { type: 'TRANSFER_RESET' }

const libraryTransferReducer = (
  _state: LibraryTransferState,
  event: LibraryTransferEvent
): LibraryTransferState => {
  switch (event.type) {
    case 'EXPORT_COMPLETED':
      return { status: 'exported' }
    case 'IMPORT_COMPLETED':
      return { status: 'imported', counts: event.counts }
    case 'TRANSFER_FAILED':
      return { status: 'failed', message: event.message }
    case 'TRANSFER_RESET':
      return { status: 'idle' }
  }
}

const pluralize = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

const describeImport = (counts: LibraryImportCounts): string => {
  const imported = `Imported ${pluralize(counts.scriptsImported, 'script')} and ${pluralize(counts.conversationsImported, 'conversation')}.`
  const skippedTotal = counts.scriptsSkipped + counts.conversationsSkipped
  return skippedTotal > 0
    ? `${imported} Skipped ${pluralize(skippedTotal, 'item')} already in the library.`
    : imported
}

type SettingsModalProps = {
  isOpen: boolean
  onClose: () => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  apiKey: string
  openRouterApiKey: string
  apiProvider: APIProvider
  model: string
  reviewPass: boolean
  debugTranscripts: boolean
  onSave: (
    apiKey: string,
    openRouterApiKey: string,
    apiProvider: APIProvider,
    model: string,
    reviewPass: boolean,
    debugTranscripts: boolean
  ) => void
  onDownloadTranscripts: (format: 'json' | 'text') => void
  onClearTranscripts: () => void
  onClearConversations: () => void
  onExportLibrary: () => Promise<void>
  onImportLibrary: (file: File) => Promise<LibraryImportCounts>
  backupReminderEnabled: boolean
  onBackupReminderEnabledChange: (enabled: boolean) => void
  backupFolderSupported: boolean
  backupFolderName: string | null
  autoBackupEnabled: boolean
  onAutoBackupEnabledChange: (enabled: boolean) => void
  onLinkBackupFolder: () => Promise<void>
  onUnlinkBackupFolder: () => Promise<void>
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
  reviewPass,
  debugTranscripts,
  onSave,
  onDownloadTranscripts,
  onClearTranscripts,
  onClearConversations,
  onExportLibrary,
  onImportLibrary,
  backupReminderEnabled,
  onBackupReminderEnabledChange,
  backupFolderSupported,
  backupFolderName,
  autoBackupEnabled,
  onAutoBackupEnabledChange,
  onLinkBackupFolder,
  onUnlinkBackupFolder
}: SettingsModalProps) => {
  const modalRef = useRef<HTMLDialogElement>(null)
  const [tempApiKey, setTempApiKey] = useState('')
  const [tempOpenRouterApiKey, setTempOpenRouterApiKey] = useState('')
  const [tempApiProvider, setTempApiProvider] = useState<APIProvider>(apiProvider || 'mock')
  const [tempModel, setTempModel] = useState(model || 'gpt-5')
  const [customModel, setCustomModel] = useState('')
  const [tempReviewPass, setTempReviewPass] = useState(reviewPass)
  const [tempDebugTranscripts, setTempDebugTranscripts] = useState(debugTranscripts)
  const transcripts = useSyncExternalStore(subscribeToTranscripts, getTranscripts)
  const [connectionTest, connectionTestDispatch] = useReducer(connectionTestReducer, { status: 'idle' })
  const [libraryTransfer, libraryTransferDispatch] = useReducer(libraryTransferReducer, { status: 'idle' })
  // Remounts the file input after each import so choosing the same file again
  // still fires a change event
  const [importRun, setImportRun] = useState(0)

  // Initialize temp values when modal opens
  useEffect(() => {
    if (isOpen) {
      setTempApiKey(apiKey || '')
      setTempOpenRouterApiKey(openRouterApiKey || '')
      setTempApiProvider(apiProvider || 'mock')
      setTempModel(model || 'gpt-5')
      setCustomModel('')
      setTempReviewPass(reviewPass)
      setTempDebugTranscripts(debugTranscripts)
      connectionTestDispatch({ type: 'TEST_RESET' })
      libraryTransferDispatch({ type: 'TRANSFER_RESET' })
    }
  }, [isOpen, apiKey, openRouterApiKey, apiProvider, model, reviewPass, debugTranscripts])

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
    onSave(
      tempApiKey.trim(),
      tempOpenRouterApiKey.trim(),
      tempApiProvider,
      finalModel,
      tempReviewPass,
      tempDebugTranscripts
    )
    onClose()
  }

  const handleClose = () => {
    modalRef.current?.close()
    onClose()
  }

  const handleProviderChange = (provider: APIProvider) => {
    setTempApiProvider(provider)
    connectionTestDispatch({ type: 'TEST_RESET' })
    if (provider === 'openai') {
      setTempModel('gpt-5')
    } else if (provider === 'openrouter') {
      setTempModel('x-ai/grok-4.5')
    }
  }

  const handleTestConnection = async () => {
    if (tempApiProvider === 'mock') return
    const key = tempApiProvider === 'openai' ? tempApiKey : tempOpenRouterApiKey
    connectionTestDispatch({ type: 'TEST_STARTED' })
    const result = await testApiConnection(tempApiProvider, key)
    connectionTestDispatch({ type: 'TEST_COMPLETED', ok: result.ok, message: result.message })
  }

  const handleExportLibrary = async () => {
    try {
      await onExportLibrary()
      libraryTransferDispatch({ type: 'EXPORT_COMPLETED' })
    } catch (error) {
      libraryTransferDispatch({
        type: 'TRANSFER_FAILED',
        message: error instanceof Error ? error.message : 'The library could not be exported'
      })
    }
  }

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setImportRun(run => run + 1)
    if (!file) return
    try {
      const counts = await onImportLibrary(file)
      libraryTransferDispatch({ type: 'IMPORT_COMPLETED', counts })
    } catch (error) {
      libraryTransferDispatch({
        type: 'TRANSFER_FAILED',
        message: error instanceof Error ? error.message : 'The file could not be imported'
      })
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
  const testableKey = tempApiProvider === 'openai' ? tempApiKey : tempOpenRouterApiKey
  const connectionMessage = connectionTest.status === 'testing'
    ? 'Testing connection...'
    : connectionTest.status === 'tested'
      ? connectionTest.message
      : ''
  const connectionOutcome = connectionTest.status === 'tested'
    ? (connectionTest.ok ? 'success' : 'failure')
    : undefined
  const libraryTransferMessage = libraryTransfer.status === 'exported'
    ? 'Library exported as a JSON file.'
    : libraryTransfer.status === 'imported'
      ? describeImport(libraryTransfer.counts)
      : libraryTransfer.status === 'failed'
        ? libraryTransfer.message
        : ''
  const libraryTransferOutcome = libraryTransfer.status === 'failed'
    ? 'failure'
    : libraryTransfer.status === 'idle'
      ? undefined
      : 'success'

  const testConnectionButton = (
    <button
      type="button"
      className="test-connection-btn"
      onClick={handleTestConnection}
      disabled={connectionTest.status === 'testing' || !testableKey.trim()}
    >
      Test connection
    </button>
  )

  const connectionTestResult = (
    <p
      className="connection-test-result"
      role="status"
      aria-live="polite"
      data-outcome={connectionOutcome}
    >
      {connectionMessage}
    </p>
  )

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
              <div className="api-key-row">
                <input
                  type="password"
                  id="api-key"
                  placeholder="Enter your OpenAI API key"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                  aria-describedby={apiKey ? "api-key-status" : "api-key-help"}
                  required
                />
                {testConnectionButton}
              </div>
              {connectionTestResult}
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
              <div className="api-key-row">
                <input
                  type="password"
                  id="openrouter-api-key"
                  placeholder="Enter your OpenRouter API key"
                  value={tempOpenRouterApiKey}
                  onChange={(e) => setTempOpenRouterApiKey(e.target.value)}
                  aria-describedby={openRouterApiKey ? "openrouter-key-status" : "openrouter-key-help"}
                  required
                />
                {testConnectionButton}
              </div>
              {connectionTestResult}
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
          <legend className="sr-only">Generation Quality</legend>

          <label className="checkbox-field" htmlFor="review-pass">
            <input
              type="checkbox"
              id="review-pass"
              checked={tempReviewPass}
              onChange={(e) => setTempReviewPass(e.target.checked)}
              aria-describedby="review-pass-help"
            />
            <span>Review pass</span>
          </label>
          <p id="review-pass-help">
            Adds two checks to each generation: one extra request critiques the
            outline against your brief before any section is written, and one
            reviews the finished script against the style rules, rewriting up
            to two violating sections — adds cost and latency
          </p>
        </fieldset>

        <fieldset>
          <legend className="sr-only">Debugging</legend>

          <label className="checkbox-field" htmlFor="debug-transcripts">
            <input
              type="checkbox"
              id="debug-transcripts"
              checked={tempDebugTranscripts}
              onChange={(e) => setTempDebugTranscripts(e.target.checked)}
              aria-describedby="debug-transcripts-help"
            />
            <span>Capture provider transcripts</span>
          </label>
          <p id="debug-transcripts-help">
            Records every request sent to the provider exactly as it goes out —
            system prompt, the example scripts embedded in it, the outline and
            conversation history, and the streamed reply — for the last
            {' '}{MAX_TRANSCRIPTS} requests. Kept in memory only for this tab,
            and discarded on reload
          </p>

          <div className="transcript-actions" role="group" aria-label="Captured transcripts">
            <button
              type="button"
              className="download-transcripts-btn"
              onClick={() => onDownloadTranscripts('json')}
              disabled={transcripts.length === 0}
            >
              <Download size={16} />
              <span>Download JSON</span>
            </button>
            <button
              type="button"
              className="download-transcripts-btn"
              onClick={() => onDownloadTranscripts('text')}
              disabled={transcripts.length === 0}
            >
              <FileText size={16} />
              <span>Download text</span>
            </button>
            <button
              type="button"
              className="clear-transcripts-btn"
              onClick={onClearTranscripts}
              disabled={transcripts.length === 0}
            >
              <Trash2 size={16} />
              <span>Clear</span>
            </button>
          </div>
          <p role="status" aria-live="polite">
            {transcripts.length === 0
              ? 'No transcripts captured'
              : `${pluralize(transcripts.length, 'transcript')} captured`}
          </p>
        </fieldset>

        <fieldset>
          <legend className="sr-only">Data Management</legend>

          <label>Data</label>
          <p>
            Your scripts and conversation history stay in this browser —
            scripts in localStorage, conversations in the browser's private
            file storage — and are not encrypted. API keys are kept in
            sessionStorage and discarded when the browser closes. Nothing is
            sent anywhere except to your chosen API provider. Clear All
            Conversations removes the stored content from this browser.
          </p>

          <div className="library-transfer" role="group" aria-label="Library backup">
            <button
              type="button"
              className="export-library-btn"
              onClick={handleExportLibrary}
            >
              <Download size={16} />
              <span>Export library</span>
            </button>
            <label className="import-library-btn">
              <Upload size={16} />
              <span>Import library</span>
              <input
                key={importRun}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={handleImportFile}
              />
            </label>
          </div>
          <p
            className="library-transfer-result"
            role="status"
            aria-live="polite"
            data-outcome={libraryTransferOutcome}
          >
            {libraryTransferMessage}
          </p>

          <label className="checkbox-field" htmlFor="backup-reminder">
            <input
              type="checkbox"
              id="backup-reminder"
              checked={backupReminderEnabled}
              onChange={(e) => onBackupReminderEnabledChange(e.target.checked)}
              aria-describedby="backup-reminder-help"
            />
            <span>Remind me to export</span>
          </label>
          <p id="backup-reminder-help">
            Shows a dismissible reminder when new scripts have accrued since
            your last export. Tracking stays in this browser
          </p>

          {backupFolderSupported && (
            <>
              {backupFolderName ? (
                <>
                  <label className="checkbox-field" htmlFor="auto-backup">
                    <input
                      type="checkbox"
                      id="auto-backup"
                      checked={autoBackupEnabled}
                      onChange={(e) => onAutoBackupEnabledChange(e.target.checked)}
                      aria-describedby="backup-folder-help"
                    />
                    <span>Back up automatically to "{backupFolderName}"</span>
                  </label>
                  <button
                    type="button"
                    className="backup-folder-btn"
                    onClick={() => { void onUnlinkBackupFolder() }}
                  >
                    <FolderX size={16} />
                    <span>Unlink backup folder</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="backup-folder-btn"
                  onClick={() => { void onLinkBackupFolder() }}
                  aria-describedby="backup-folder-help"
                >
                  <FolderSync size={16} />
                  <span>Link backup folder</span>
                </button>
              )}
              <p id="backup-folder-help">
                Writes the library export file into a folder you choose after
                significant changes, at most every few minutes. The folder is
                on this device and nothing is sent anywhere remote
              </p>
            </>
          )}

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
