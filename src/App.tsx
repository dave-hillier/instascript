import { useReducer, useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { Settings, ArrowLeft, Check, Copy, Download, Eye, EyeOff, Library, Theater } from 'lucide-react'
import { useAppContext } from './hooks/useAppContext'
import { useConversationContext } from './hooks/useConversationContext'
import { SettingsModal } from './components/SettingsModal'
import { InlineTitleEditor } from './components/InlineTitleEditor'
import { buildConsolidatedMarkdown, markdownFilename } from './utils/scriptExport'
import { HomePage } from './pages/HomePage'
import { ScriptPage } from './pages/ScriptPage'
import { ExamplesPage } from './pages/ExamplesPage'
import type { APIProvider } from './services/config'
import { clearStoredConversations, loadStoredConversations, saveStoredConversation } from './services/conversationStorage'
import { serializeLibraryExport, parseLibraryExport, mergeLibrary, type LibraryImportCounts } from './services/libraryTransfer'
import { getExampleSelectionCounts, importExampleSelectionCounts } from './services/exampleCorpus'
import { BackupReminder } from './components/BackupReminder'
import {
  evaluateBackupReminder,
  loadExportSnapshot,
  recordLibraryExported,
  loadReminderDismissal,
  recordReminderDismissed,
  loadReminderEnabled,
  saveReminderEnabled,
  loadAutoBackupEnabled,
  saveAutoBackupEnabled,
  loadAutoBackupLastWrittenAt,
  loadAutoBackupSignature,
  recordAutoBackupWritten,
  autoBackupDelay,
  librarySignature
} from './services/backupReminder'
import {
  isBackupFolderSupported,
  pickBackupFolder,
  loadBackupFolderHandle,
  storeBackupFolderHandle,
  clearBackupFolderHandle,
  ensureBackupPermission,
  writeBackupFile
} from './services/backupFolder'
import './App.css'

type Theme = 'light' | 'dark' | 'system'

type ThemeAction = { type: 'SET_THEME'; theme: Theme }
type ModalAction = { type: 'TOGGLE_SETTINGS_MODAL' }
type SectionTitlesAction = { type: 'TOGGLE_SECTION_TITLES' }
type PerformanceModeAction =
  | { type: 'PERFORMANCE_MODE_TOGGLED' }
  | { type: 'PERFORMANCE_MODE_EXITED' }

type UIState = {
  theme: Theme
  showSettingsModal: boolean
  showSectionTitles: boolean
  performanceMode: boolean
}

type UIAction = ThemeAction | ModalAction | SectionTitlesAction | PerformanceModeAction


const uiReducer = (state: UIState, action: UIAction): UIState => {
  switch (action.type) {
    case 'SET_THEME':
      return { ...state, theme: action.theme }
    case 'TOGGLE_SETTINGS_MODAL':
      return { ...state, showSettingsModal: !state.showSettingsModal }
    case 'TOGGLE_SECTION_TITLES':
      return { ...state, showSectionTitles: !state.showSectionTitles }
    case 'PERFORMANCE_MODE_TOGGLED':
      return { ...state, performanceMode: !state.performanceMode }
    case 'PERFORMANCE_MODE_EXITED':
      return state.performanceMode ? { ...state, performanceMode: false } : state
    default:
      return state
  }
}

function AppContent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const {
    getConversationByScriptId,
    state: conversationState,
    dispatch: conversationDispatch
  } = useConversationContext()

  const [uiState, uiDispatch] = useReducer(uiReducer, {
    theme: (() => {
      try {
        const item = window.localStorage.getItem('theme')
        return item ? JSON.parse(item) : 'system'
      } catch {
        return 'system'
      }
    })(),
    showSettingsModal: false,
    showSectionTitles: (() => {
      try {
        const item = window.localStorage.getItem('showSectionTitles')
        return item ? JSON.parse(item) : true
      } catch {
        return true
      }
    })(),
    performanceMode: false
  })

  // Brief "Copied" confirmation after copying the script to the clipboard
  const [copyConfirmed, setCopyConfirmed] = useState(false)

  const [apiKey, setApiKey] = useState(() => {
    try {
      // Migrate API key from localStorage to sessionStorage if present
      const legacyItem = window.localStorage.getItem('OPENAI_API_KEY')
      if (legacyItem) {
        const key = JSON.parse(legacyItem)
        if (key) {
          window.sessionStorage.setItem('OPENAI_API_KEY', JSON.stringify(key))
        }
        window.localStorage.removeItem('OPENAI_API_KEY')
        return key || ''
      }
      // Read from sessionStorage (not persisted across browser sessions)
      const item = window.sessionStorage.getItem('OPENAI_API_KEY')
      return item ? JSON.parse(item) : ''
    } catch {
      return ''
    }
  })

  const [openRouterApiKey, setOpenRouterApiKey] = useState(() => {
    try {
      const item = window.sessionStorage.getItem('OPENROUTER_API_KEY')
      return item ? JSON.parse(item) : ''
    } catch {
      return ''
    }
  })

  const [apiProvider, setApiProvider] = useState<APIProvider>(() => {
    try {
      const item = window.localStorage.getItem('apiProvider')
      return item ? JSON.parse(item) : 'mock'
    } catch {
      return 'mock'
    }
  })

  const [model, setModel] = useState<string>(() => {
    try {
      const item = window.localStorage.getItem('model')
      return item ? JSON.parse(item) : 'gpt-5'
    } catch {
      return 'gpt-5'
    }
  })
  // Opt-in style-review pass after each full generation (story 8.5)
  const [reviewPass, setReviewPass] = useState<boolean>(() => {
    try {
      const item = window.localStorage.getItem('reviewPass')
      return item ? JSON.parse(item) === true : false
    } catch {
      return false
    }
  })

  // Backup staleness tracking and the linked backup folder (story 7.4).
  // All of it is strictly local: localStorage for the small state, IndexedDB
  // for the directory handle, and writes only to a folder the user picked.
  const [backupReminderEnabled, setBackupReminderEnabled] = useState(loadReminderEnabled)
  const [exportSnapshot, setExportSnapshot] = useState(loadExportSnapshot)
  const [reminderDismissal, setReminderDismissal] = useState(loadReminderDismissal)
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(loadAutoBackupEnabled)
  const [backupFolder, setBackupFolder] = useState<FileSystemDirectoryHandle | null>(null)

  // Restore a previously linked backup folder handle from IndexedDB
  useEffect(() => {
    let cancelled = false
    void loadBackupFolderHandle().then(handle => {
      if (!cancelled && handle) setBackupFolder(handle)
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  // Save theme preference when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('theme', JSON.stringify(uiState.theme))
    } catch (error) {
      console.error('Error saving theme to localStorage:', error)
    }
  }, [uiState.theme])

  // Save OpenAI API key to sessionStorage
  useEffect(() => {
    try {
      window.sessionStorage.setItem('OPENAI_API_KEY', JSON.stringify(apiKey))
    } catch (error) {
      console.error('Error saving API key to sessionStorage:', error)
    }
  }, [apiKey])

  // Save OpenRouter API key to sessionStorage
  useEffect(() => {
    try {
      window.sessionStorage.setItem('OPENROUTER_API_KEY', JSON.stringify(openRouterApiKey))
    } catch (error) {
      console.error('Error saving OpenRouter API key to sessionStorage:', error)
    }
  }, [openRouterApiKey])

  // Save API provider when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('apiProvider', JSON.stringify(apiProvider))
    } catch (error) {
      console.error('Error saving API provider to localStorage:', error)
    }
  }, [apiProvider])

  // Save model when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('model', JSON.stringify(model))
    } catch (error) {
      console.error('Error saving model to localStorage:', error)
    }
  }, [model])

  // Save review pass preference when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('reviewPass', JSON.stringify(reviewPass))
    } catch (error) {
      console.error('Error saving review pass setting to localStorage:', error)
    }
  }, [reviewPass])

  // Save section titles visibility when it changes
  useEffect(() => {
    try {
      window.localStorage.setItem('showSectionTitles', JSON.stringify(uiState.showSectionTitles))
    } catch (error) {
      console.error('Error saving section titles visibility to localStorage:', error)
    }
  }, [uiState.showSectionTitles])

  // Determine effective theme (resolve 'system' to actual theme)
  const effectiveTheme = uiState.theme === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : uiState.theme

  const isScriptPage = location.pathname.startsWith('/script/')
  const isExamplesPage = location.pathname === '/examples'

  // Extract script ID from URL and get script title
  const scriptId = isScriptPage ? location.pathname.split('/script/')[1] : null
  const currentScript = scriptId ? state.scripts.find(s => s.id === scriptId) : null
  const headerTitle = isScriptPage && currentScript ? currentScript.title : 'InstaScript'

  // The full consolidated markdown for copy/export (story 4.1): built from the
  // conversation so it always reflects regenerated and edited sections
  const currentConversation = currentScript ? getConversationByScriptId(currentScript.id) : undefined
  const exportMarkdown = currentScript && currentConversation
    ? buildConsolidatedMarkdown(
        currentConversation,
        currentScript.title,
        // Once complete, the stored title is canonical (the orchestrator syncs
        // it from the outline), so a manual rename carries into the export
        currentScript.status === 'complete' ? currentScript.title : undefined
      )
    : ''

  // Leaving the script page always leaves performance mode with it
  useEffect(() => {
    uiDispatch({ type: 'PERFORMANCE_MODE_EXITED' })
  }, [location.pathname])

  const handleCopyScript = async () => {
    if (!exportMarkdown) return
    try {
      await navigator.clipboard.writeText(exportMarkdown)
      setCopyConfirmed(true)
      window.setTimeout(() => setCopyConfirmed(false), 2000)
    } catch (error) {
      console.error('Error copying script to clipboard:', error)
    }
  }

  const handleDownloadScript = () => {
    if (!exportMarkdown || !currentScript) return
    const blob = new Blob([exportMarkdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = markdownFilename(currentScript.title)
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleRenameScript = (title: string) => {
    if (!currentScript) return
    dispatch({ type: 'UPDATE_SCRIPT', scriptId: currentScript.id, updates: { title } })
  }


  const handleSaveSettings = (newApiKey: string, newOpenRouterApiKey: string, newApiProvider: APIProvider, newModel: string, newReviewPass: boolean) => {
    if (newApiKey.trim()) {
      setApiKey(newApiKey.trim())
    }
    if (newOpenRouterApiKey.trim()) {
      setOpenRouterApiKey(newOpenRouterApiKey.trim())
    }
    setApiProvider(newApiProvider)
    setModel(newModel)
    setReviewPass(newReviewPass)
  }

  const handleClearConversations = () => {
    if (confirm('Are you sure you want to clear all conversations and scripts? This action cannot be undone.')) {
      // Clear all conversation_* and script_* keys from localStorage
      const keys = Object.keys(localStorage)
      for (const key of keys) {
        if (key.startsWith('conversation_') || key.startsWith('script_')) {
          localStorage.removeItem(key)
        }
      }
      // Also clear old formats if they exist
      localStorage.removeItem('conversations')
      localStorage.removeItem('scripts')
      // Conversations persist to OPFS (with localStorage as fallback);
      // clear that store too, and the in-memory conversation state with it
      void clearStoredConversations()
      conversationDispatch({ type: 'CONVERSATIONS_CLEARED' })
      // Clear scripts from state (they're stored in localStorage via AppProvider)
      dispatch({ type: 'CLEAR_SCRIPTS' })
      // Close the modal
      uiDispatch({ type: 'TOGGLE_SETTINGS_MODAL' })
      // Navigate to home page if currently on a script page
      if (isScriptPage) {
        navigate('/')
      }
    }
  }

  // Exports every script and conversation as one JSON file (story 7.2).
  // Conversations are read back through the storage layer, which is the
  // source of truth whether they live in OPFS or localStorage.
  const handleExportLibrary = async () => {
    const conversations = await loadStoredConversations()
    const json = serializeLibraryExport(state.scripts, conversations, getExampleSelectionCounts())
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `instascript-library-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    // Remember what this export covered, so the staleness reminder measures
    // new work against it (story 7.4); a fresh export also clears dismissals
    setExportSnapshot(recordLibraryExported(state.scripts.map(script => script.id), Date.now()))
    setReminderDismissal(null)
  }

  // Conversation-level work (regenerated, refined or hand-edited sections)
  // never touches script fields, so the reminder and the automatic backup
  // must watch conversation updates too
  const latestConversationUpdateAt = conversationState.conversations.reduce(
    (latest: number | null, conversation) =>
      latest === null ? conversation.updatedAt : Math.max(latest, conversation.updatedAt),
    null
  )

  const backupReminder = evaluateBackupReminder({
    enabled: backupReminderEnabled,
    snapshot: exportSnapshot,
    currentScriptIds: state.scripts.map(script => script.id),
    dismissal: reminderDismissal,
    now: Date.now(),
    latestConversationUpdateAt
  })

  const handleDismissBackupReminder = () => {
    setReminderDismissal(recordReminderDismissed(backupReminder.newScriptCount, Date.now()))
  }

  const handleBackupReminderEnabledChange = (enabled: boolean) => {
    saveReminderEnabled(enabled)
    setBackupReminderEnabled(enabled)
  }

  const handleAutoBackupEnabledChange = (enabled: boolean) => {
    saveAutoBackupEnabled(enabled)
    setAutoBackupEnabled(enabled)
  }

  const handleLinkBackupFolder = async () => {
    const handle = await pickBackupFolder()
    if (!handle) return
    await ensureBackupPermission(handle, true)
    // Persisting the handle can fail in browsers that cannot clone handles
    // into IndexedDB; the link then simply lasts for this session
    await storeBackupFolderHandle(handle)
    setBackupFolder(handle)
    handleAutoBackupEnabledChange(true)
  }

  const handleUnlinkBackupFolder = async () => {
    await clearBackupFolderHandle()
    setBackupFolder(null)
    handleAutoBackupEnabledChange(false)
  }

  // Automatic backup into the linked folder after significant changes,
  // throttled so streaming generations do not cause a write per token. The
  // signature check skips writes when nothing has actually changed.
  useEffect(() => {
    if (!autoBackupEnabled || !backupFolder || state.scripts.length === 0) return
    const scripts = state.scripts
    const conversationSignatures = conversationState.conversations.map(conversation => ({
      id: conversation.id,
      updatedAt: conversation.updatedAt
    }))
    const writeBackup = async () => {
      try {
        const signature = librarySignature(scripts, conversationSignatures)
        if (signature === loadAutoBackupSignature()) return
        // Without a user gesture we can only use an already granted permission
        if (!(await ensureBackupPermission(backupFolder, false))) return
        const conversations = await loadStoredConversations()
        await writeBackupFile(
          backupFolder,
          serializeLibraryExport(scripts, conversations, getExampleSelectionCounts())
        )
        recordAutoBackupWritten(signature, Date.now())
      } catch (error) {
        console.error('Automatic backup failed:', error)
      }
    }
    const delay = autoBackupDelay(loadAutoBackupLastWrittenAt(), Date.now())
    const timer = window.setTimeout(() => {
      void writeBackup()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [autoBackupEnabled, backupFolder, state.scripts, conversationState.conversations])

  // Imports a previously exported library, merging it into this browser:
  // anything whose id already exists here is skipped, never overwritten.
  // Throws with a readable reason on an invalid file; the settings dialog
  // shows it inline.
  const handleImportLibrary = async (file: File): Promise<LibraryImportCounts> => {
    const imported = parseLibraryExport(await file.text())
    // Selection counts merge per example, keeping the higher value, so an
    // import never lowers or double-counts what this browser already knows
    importExampleSelectionCounts(imported.exampleSelectionCounts)
    const storedConversations = await loadStoredConversations()
    const result = mergeLibrary(imported, {
      scriptIds: state.scripts.map(script => script.id),
      // Collision checks cover both what is persisted and anything created
      // in memory this session that storage has not caught up with yet
      conversations: [...storedConversations, ...conversationState.conversations]
    })
    for (const script of result.newScripts) {
      // A script exported mid-generation cannot still be generating here —
      // reconcile it to draft, as the loader does for interrupted scripts
      dispatch({
        type: 'ADD_SCRIPT',
        script: script.status === 'in-progress' ? { ...script, status: 'draft' } : script
      })
    }
    for (const conversation of result.newConversations) {
      saveStoredConversation(conversation)
    }
    if (result.newConversations.length > 0) {
      conversationDispatch({ type: 'LOAD_CONVERSATIONS', conversations: result.newConversations })
    }
    return result
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
          {(isScriptPage || isExamplesPage) && (
            <button
              onClick={() => navigate('/')}
              aria-label="Go back"
              type="button"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div>
            {isScriptPage && currentScript ? (
              <InlineTitleEditor
                title={currentScript.title}
                onRename={handleRenameScript}
              />
            ) : (
              <h1>
                {headerTitle}
              </h1>
            )}
            {isScriptPage && currentScript && (
              <div>
                <span>{currentScript.createdAt}</span>
                {currentScript.provider && currentScript.model && (
                  <span> · {currentScript.provider}/{currentScript.model}</span>
                )}
                {currentScript.status && <span> · {currentScript.status}</span>}
                {currentScript.length && <span> · {currentScript.length}</span>}
              </div>
            )}
          </div>
        </div>
        <nav>
          {isScriptPage && (
            <>
              <button
                onClick={handleCopyScript}
                disabled={!exportMarkdown}
                aria-label="Copy script to clipboard"
                type="button"
              >
                {copyConfirmed ? <Check size={18} /> : <Copy size={18} />}
              </button>
              <span className="sr-only" role="status" aria-live="polite">
                {copyConfirmed ? 'Copied to clipboard' : ''}
              </span>
              <button
                onClick={handleDownloadScript}
                disabled={!exportMarkdown}
                aria-label="Download script as Markdown"
                type="button"
              >
                <Download size={18} />
              </button>
              <button
                onClick={() => uiDispatch({ type: 'PERFORMANCE_MODE_TOGGLED' })}
                disabled={!exportMarkdown}
                aria-label="Enter performance mode"
                type="button"
              >
                <Theater size={18} />
              </button>
              <button
                onClick={() => uiDispatch({ type: 'TOGGLE_SECTION_TITLES' })}
                aria-label={uiState.showSectionTitles ? "Hide section titles" : "Show section titles"}
                type="button"
              >
                {uiState.showSectionTitles ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </>
          )}
          {!isExamplesPage && (
            <button
              onClick={() => navigate('/examples')}
              aria-label="Manage example corpus"
              type="button"
            >
              <Library size={18} />
            </button>
          )}
          <button
            onClick={handleOpenSettings}
            aria-label="Open settings"
            type="button"
          >
            <Settings size={18} />
          </button>
        </nav>
      </header>

      {backupReminder.due && !uiState.performanceMode && (
        <BackupReminder
          newScriptCount={backupReminder.newScriptCount}
          lastExportedAt={backupReminder.lastExportedAt}
          onExport={() => {
            void handleExportLibrary()
          }}
          onDismiss={handleDismissBackupReminder}
        />
      )}

      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/script/:id"
            element={
              <ScriptPage
                showSectionTitles={uiState.showSectionTitles}
                performanceMode={uiState.performanceMode}
                onExitPerformanceMode={() => uiDispatch({ type: 'PERFORMANCE_MODE_EXITED' })}
              />
            }
          />
          <Route path="/examples" element={<ExamplesPage />} />
        </Routes>
      </main>

      <SettingsModal
        isOpen={uiState.showSettingsModal}
        onClose={handleCloseModal}
        theme={uiState.theme}
        onThemeChange={handleThemeChange}
        apiKey={apiKey || ''}
        openRouterApiKey={openRouterApiKey || ''}
        apiProvider={apiProvider || 'mock'}
        model={model || 'gpt-5'}
        reviewPass={reviewPass}
        onSave={handleSaveSettings}
        onClearConversations={handleClearConversations}
        onExportLibrary={handleExportLibrary}
        onImportLibrary={handleImportLibrary}
        backupReminderEnabled={backupReminderEnabled}
        onBackupReminderEnabledChange={handleBackupReminderEnabledChange}
        backupFolderSupported={isBackupFolderSupported()}
        backupFolderName={backupFolder ? backupFolder.name : null}
        autoBackupEnabled={autoBackupEnabled}
        onAutoBackupEnabledChange={handleAutoBackupEnabledChange}
        onLinkBackupFolder={handleLinkBackupFolder}
        onUnlinkBackupFolder={handleUnlinkBackupFolder}
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
