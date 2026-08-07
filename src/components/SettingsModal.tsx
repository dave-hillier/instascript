import { useRef, useEffect, useState, useReducer, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import { Sun, Moon, Monitor, Trash2, Download, Upload, FolderSync, FolderX, FileText } from 'lucide-react'
import { subscribeToTranscripts, getTranscripts, MAX_TRANSCRIPTS } from '../services/debugTranscript'
import {
  MAX_CACHE_BYTES,
  clearCachedAudio,
  speechCacheUsage,
  type SpeechCacheUsage,
} from '../services/speechAudioCache'
import { formatBytes } from '../utils/formatBytes'
import { getDefaultModel, type APIProvider } from '../services/config'
import {
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  OPENAI_UTILITY_MODELS,
  OPENROUTER_UTILITY_MODELS,
  type ModelOption
} from '../services/modelPresets'
import { testApiConnection } from '../services/connectionTest'
import type { LibraryImportCounts } from '../services/libraryTransfer'

type Theme = 'light' | 'dark' | 'system'

const CUSTOM_MODEL = 'custom'

type ModelFieldProps = {
  id: string
  label: string
  help: string
  options: ModelOption[]
  allowCustom: boolean
  value: string
  onChange: (model: string) => void
}

// One model picker: a preset list plus, where the provider allows any model
// id, a free-text field. A value outside the presets is a custom model, so
// the two controls need no extra state to stay in step.
const ModelField = ({ id, label, help, options, allowCustom, value, onChange }: ModelFieldProps) => {
  const isPreset = options.some(option => option.value === value)

  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={isPreset ? value : CUSTOM_MODEL}
        onChange={event => onChange(event.target.value === CUSTOM_MODEL ? '' : event.target.value)}
        aria-describedby={`${id}-help`}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
        {allowCustom && <option value={CUSTOM_MODEL}>Custom model...</option>}
      </select>

      {allowCustom && !isPreset && (
        <>
          <label htmlFor={`${id}-custom`}>Custom model ID</label>
          <input
            type="text"
            id={`${id}-custom`}
            placeholder="e.g. x-ai/grok-4.3, anthropic/claude-sonnet-4"
            value={value}
            onChange={event => onChange(event.target.value)}
            aria-describedby={`${id}-custom-help`}
          />
          <p id={`${id}-custom-help`}>Enter any OpenRouter model ID</p>
        </>
      )}

      <p id={`${id}-help`}>{help}</p>
    </>
  )
}

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

// What Save hands back. An object rather than a positional list: the app has
// enough settings now that argument order would be a trap.
export type SettingsFormValues = {
  apiKey: string
  openRouterApiKey: string
  apiProvider: APIProvider
  model: string
  utilityModel: string
  importAssist: boolean
  reviewPass: boolean
  debugTranscripts: boolean
  styleInstructions: string
  importInstructions: string
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
  utilityModel: string
  importAssist: boolean
  reviewPass: boolean
  debugTranscripts: boolean
  styleInstructions: string
  importInstructions: string
  onSave: (settings: SettingsFormValues) => void
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
  utilityModel,
  importAssist,
  reviewPass,
  debugTranscripts,
  styleInstructions,
  importInstructions,
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
  const [tempUtilityModel, setTempUtilityModel] = useState(utilityModel)
  const [tempImportAssist, setTempImportAssist] = useState(importAssist)
  const [tempReviewPass, setTempReviewPass] = useState(reviewPass)
  const [tempDebugTranscripts, setTempDebugTranscripts] = useState(debugTranscripts)
  const [tempStyleInstructions, setTempStyleInstructions] = useState(styleInstructions)
  const [tempImportInstructions, setTempImportInstructions] = useState(importInstructions)
  const transcripts = useSyncExternalStore(subscribeToTranscripts, getTranscripts)
  const [connectionTest, connectionTestDispatch] = useReducer(connectionTestReducer, { status: 'idle' })
  const [libraryTransfer, libraryTransferDispatch] = useReducer(libraryTransferReducer, { status: 'idle' })
  // Remounts the file input after each import so choosing the same file again
  // still fires a change event
  const [importRun, setImportRun] = useState(0)
  // Null until the cache has been measured, which is a read of the whole
  // store and so happens only while the panel is open
  const [speechCache, setSpeechCache] = useState<SpeechCacheUsage | null>(null)

  // Initialize temp values when modal opens
  useEffect(() => {
    if (isOpen) {
      setTempApiKey(apiKey || '')
      setTempOpenRouterApiKey(openRouterApiKey || '')
      setTempApiProvider(apiProvider || 'mock')
      setTempModel(model || 'gpt-5')
      setTempUtilityModel(utilityModel)
      setTempImportAssist(importAssist)
      setTempReviewPass(reviewPass)
      setTempDebugTranscripts(debugTranscripts)
      setTempStyleInstructions(styleInstructions)
      setTempImportInstructions(importInstructions)
      connectionTestDispatch({ type: 'TEST_RESET' })
      libraryTransferDispatch({ type: 'TRANSFER_RESET' })
    }
  }, [
    isOpen,
    apiKey,
    openRouterApiKey,
    apiProvider,
    model,
    utilityModel,
    importAssist,
    reviewPass,
    debugTranscripts,
    styleInstructions,
    importInstructions
  ])

  // Open/close modal based on isOpen prop
  useEffect(() => {
    if (isOpen) {
      modalRef.current?.showModal()
    } else {
      modalRef.current?.close()
    }
  }, [isOpen])

  // Measure the voice audio cache each time the panel opens, and ignore a
  // measurement that arrives after it has closed again
  useEffect(() => {
    if (!isOpen) {
      setSpeechCache(null)
      return
    }
    let current = true
    void speechCacheUsage().then((usage) => {
      if (current) setSpeechCache(usage)
    })
    return () => { current = false }
  }, [isOpen])

  const handleClearSpeechCache = async () => {
    await clearCachedAudio()
    setSpeechCache(await speechCacheUsage())
  }

  const handleSave = () => {
    // An empty custom model field falls back to the provider's default rather
    // than saving a model id that cannot be called
    onSave({
      apiKey: tempApiKey.trim(),
      openRouterApiKey: tempOpenRouterApiKey.trim(),
      apiProvider: tempApiProvider,
      model: tempModel.trim() || getDefaultModel(tempApiProvider, 'generation'),
      utilityModel: tempUtilityModel.trim() || getDefaultModel(tempApiProvider, 'utility'),
      importAssist: tempImportAssist,
      reviewPass: tempReviewPass,
      debugTranscripts: tempDebugTranscripts,
      // Trimmed here as well as on the way into storage, so a field holding
      // only whitespace is the same as an unset one and appends nothing
      styleInstructions: tempStyleInstructions.trim(),
      importInstructions: tempImportInstructions.trim()
    })
    onClose()
  }

  const handleClose = () => {
    modalRef.current?.close()
    onClose()
  }

  // Model ids do not carry across providers, so both roles go back to the new
  // provider's defaults
  const handleProviderChange = (provider: APIProvider) => {
    setTempApiProvider(provider)
    connectionTestDispatch({ type: 'TEST_RESET' })
    if (provider !== 'mock') {
      setTempModel(getDefaultModel(provider, 'generation'))
      setTempUtilityModel(getDefaultModel(provider, 'utility'))
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
  const utilityModelOptions = tempApiProvider === 'openai'
    ? OPENAI_UTILITY_MODELS
    : OPENROUTER_UTILITY_MODELS
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
              <ModelField
                id="model-selector"
                label="Generation model"
                help="Writes the scripts: outlines, sections, refinements and the review pass"
                options={modelOptions}
                allowCustom={tempApiProvider === 'openrouter'}
                value={tempModel}
                onChange={setTempModel}
              />

              <ModelField
                id="utility-model-selector"
                label="Utility model"
                help="Handles the short background jobs — suggesting tags for imported examples and formatting plain-text imports as markdown. A small cheap model is faster and costs a fraction of the generation model"
                options={utilityModelOptions}
                allowCustom={tempApiProvider === 'openrouter'}
                value={tempUtilityModel}
                onChange={setTempUtilityModel}
              />
            </>
          )}

          <label className="checkbox-field" htmlFor="import-assist">
            <input
              type="checkbox"
              id="import-assist"
              checked={tempImportAssist}
              onChange={(e) => setTempImportAssist(e.target.checked)}
              aria-describedby="import-assist-help"
            />
            <span>Tidy imported examples with the utility model</span>
          </label>
          <p id="import-assist-help">
            After importing an example, asks the utility model to suggest tags
            for it and, when the file is unstructured plain text, to lay it out
            as markdown with headings. The wording is never changed — a
            rewritten script is discarded and the import kept as it was. Off
            means imports stay entirely local
          </p>

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
          <legend className="sr-only">Standing Instructions</legend>

          <label htmlFor="style-instructions">Overall style</label>
          <textarea
            id="style-instructions"
            rows={4}
            value={tempStyleInstructions}
            onChange={(e) => setTempStyleInstructions(e.target.value)}
            placeholder="e.g. British spelling. Keep the imagery to water and weather. Never use countdowns"
            aria-describedby="style-instructions-help"
          />
          <p id="style-instructions-help">
            Added to every request that writes prose — the outline, each
            section, section rewrites, whole-script refinements and the review
            pass — on top of the app's own style rules, and taking precedence
            over them where the two differ. Left empty, the prompts go out
            exactly as they ship
          </p>

          <label htmlFor="import-instructions">Imported material</label>
          <textarea
            id="import-instructions"
            rows={4}
            value={tempImportInstructions}
            onChange={(e) => setTempImportInstructions(e.target.value)}
            placeholder="e.g. Split long inductions into their own sections. Tag by the trigger the script installs"
            aria-describedby="import-instructions-help"
          />
          <p id="import-instructions-help">
            Added to the utility-model jobs that run over an imported example:
            laying plain text out as markdown, suggesting tags, and the
            direct-address rewrite. The checks on those jobs are unchanged, so
            an instruction that would have the model reword a script still ends
            with the import kept as it arrived
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

          <div className="speech-cache" role="group" aria-label="Voice audio cache">
            <button
              type="button"
              className="clear-speech-cache-btn"
              onClick={handleClearSpeechCache}
              disabled={!speechCache || speechCache.entries === 0}
            >
              <Trash2 size={16} />
              <span>Clear voice audio</span>
            </button>
            <p role="status" aria-live="polite">
              {!speechCache
                ? 'Measuring cached voice audio'
                : speechCache.entries === 0
                  ? 'No voice audio cached'
                  : `${formatBytes(speechCache.bytes)} across ${pluralize(speechCache.entries, 'line')}`}
            </p>
          </div>
          <p>
            Lines spoken by a hosted voice are kept so replaying or exporting a
            script does not pay for them again. Held to{' '}
            {formatBytes(MAX_CACHE_BYTES)}, discarding the least recently heard
            first. Clearing costs nothing but re-synthesising what you play next
          </p>

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
