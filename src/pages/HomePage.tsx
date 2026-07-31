import { ArrowUp } from 'lucide-react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useState, useSyncExternalStore } from 'react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { ScriptList } from '../components/ScriptList'
import type { Script } from '../types/script'
import { createAppConfig, getModel } from '../services/config'
import { providerUsedFor, resolveProviderStatus, unavailableReason } from '../services/providerStatus'
import { subscribeToConfig, getConfigRevision } from '../services/configStore'
import { filterScriptsByQuery, parseSortOrder, sortScriptsByCreation } from '../utils/scriptLibrary'
import type { SortOrder } from '../utils/scriptLibrary'
import {
  buildLengthPlan,
  formatTargetLength,
  DEFAULT_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
  MAX_TARGET_MINUTES,
  TARGET_MINUTES_STEP
} from '../services/scriptLength'

type Tab = 'scripts' | 'archive'

export const HomePage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [prompt, setPrompt] = useState('')
  const [targetMinutes, setTargetMinutes] = useState(DEFAULT_TARGET_MINUTES)
  const navigate = useNavigate()

  // The requested length, shown as both the duration the user is choosing and
  // the word count it works out to
  const lengthPlan = buildLengthPlan(targetMinutes)

  // Resolved on every render so a key entered in Settings takes effect without
  // a reload, and so the page can say which provider will really answer. The
  // settings are written to storage after the render that saved them, so the
  // subscription is what brings this page back to read them.
  useSyncExternalStore(subscribeToConfig, getConfigRevision)
  const providerStatus = resolveProviderStatus(createAppConfig())
  const providerWarning = unavailableReason(providerStatus)

  const { activeScripts, archivedScripts, dispatch: appDispatch } = useAppContext()
  const { createConversation, generateScript } = useConversationContext()

  const activeTab = (searchParams.get('state') === 'archived' ? 'archive' : 'scripts') as Tab
  const searchQuery = searchParams.get('q') ?? ''
  const sortOrder = parseSortOrder(searchParams.get('sort'))

  const tabScripts = activeTab === 'scripts' ? activeScripts : archivedScripts
  const visibleScripts = sortScriptsByCreation(
    filterScriptsByQuery(tabScripts, searchQuery),
    sortOrder
  )

  // Applies partial updates to the query string, dropping keys set to null
  // so defaults (scripts tab, no search, newest first) keep clean URLs
  const updateSearchParams = (
    updates: Record<string, string | null>,
    options?: { replace?: boolean }
  ) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    setSearchParams(next, options)
  }

  const handleTabSelected = (tab: Tab) => {
    updateSearchParams({ state: tab === 'archive' ? 'archived' : null })
  }

  const handleSearchChanged = (value: string) => {
    updateSearchParams({ q: value }, { replace: true })
  }

  const handleSortChanged = (order: SortOrder) => {
    updateSearchParams({ sort: order === 'oldest' ? 'oldest' : null })
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) return

    try {
      // Create new script entry
      const scriptId = `script_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const script: Script = {
        id: scriptId,
        title: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
        content: '',
        createdAt: new Date().toLocaleDateString(),
        isArchived: false,
        status: 'in-progress',
        initialPrompt: prompt,
        targetMinutes,
        // The provider that will actually serve the request, not the one
        // selected: a mocked script must not be labelled as a real one
        provider: providerUsedFor(providerStatus),
        model: getModel()
      }

      // Create conversation
      const conversation = createConversation(scriptId)
      script.conversationId = conversation.id

      // Add script to app state
      appDispatch({ type: 'ADD_SCRIPT', script })

      // Navigate to the script page
      navigate(`/script/${scriptId}`)

      // Clear the prompt
      setPrompt('')

      // Start generation directly (no job queue)
      await generateScript({
        prompt: prompt,
        conversationId: conversation.id,
        targetMinutes
      })

    } catch (error) {
      console.error('Failed to queue script generation:', error)
    }
  }

  return (
    <>
      <section>
        <h2>What script should we generate?</h2>
      </section>

      {providerWarning && (
        <aside role="alert" className="provider-notice provider-notice-error">
          <p>{providerWarning}</p>
        </aside>
      )}

      {providerStatus.kind === 'mock' && (
        <aside role="status" className="provider-notice">
          <p>
            The mock provider is selected, so scripts are placeholder text rather
            than generated writing. Choose a real provider in Settings.
          </p>
        </aside>
      )}

      <section>
        <form onSubmit={(e) => { e.preventDefault(); handleGenerate(); }}>
          <textarea
            placeholder="Describe a script to generate"
            aria-label="Script description"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div>
            <div>
              <label htmlFor="target-length">Length</label>
              <input
                id="target-length"
                type="range"
                min={MIN_TARGET_MINUTES}
                max={MAX_TARGET_MINUTES}
                step={TARGET_MINUTES_STEP}
                value={targetMinutes}
                onChange={(e) => setTargetMinutes(Number(e.target.value))}
                aria-describedby="target-length-value"
              />
              <output id="target-length-value" htmlFor="target-length">
                {formatTargetLength(lengthPlan)}
              </output>
            </div>
            <div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!prompt.trim() || !!providerWarning}
                aria-label="Generate script"
              >
                <ArrowUp size={24} />
              </button>
            </div>
          </div>
        </form>
      </section>

      <section>
        <search>
          <input
            type="search"
            placeholder="Search scripts"
            aria-label="Search scripts by title or prompt"
            value={searchQuery}
            onChange={(e) => handleSearchChanged(e.target.value)}
          />
          <select
            aria-label="Sort scripts"
            value={sortOrder}
            onChange={(e) => handleSortChanged(parseSortOrder(e.target.value))}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </search>
        <div
          role="tablist"
          aria-label="Script categories"
        >
          <button
            role="tab"
            aria-selected={activeTab === 'scripts'}
            aria-controls="scripts-panel"
            id="scripts-tab"
            onClick={() => handleTabSelected('scripts')}
            type="button"
          >
            Scripts
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'archive'}
            aria-controls="archive-panel"
            id="archive-tab"
            onClick={() => handleTabSelected('archive')}
            type="button"
          >
            Archive
          </button>
        </div>
      </section>

      <section
        role="tabpanel"
        id={`${activeTab}-panel`}
        aria-labelledby={`${activeTab}-tab`}
      >
        <ScriptList
          scripts={visibleScripts}
          showArchived={activeTab === 'archive'}
          searchQuery={searchQuery}
        />
      </section>
    </>
  )
}
