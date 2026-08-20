import { ArrowUp } from 'lucide-react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useState, useSyncExternalStore } from 'react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { ScriptList } from '../components/ScriptList'
import { BriefingStage } from '../components/BriefingStage'
import type { Script } from '../types/script'
import {
  createAppConfig,
  getModel,
  getStyleFidelity,
  isBriefingStageEnabled,
  setBriefingStageEnabled,
  setStyleFidelity
} from '../services/config'
import {
  areActiveDevicesGeneralised,
  parseStyleFidelity,
  type StyleFidelity
} from '../services/corpusDevices'
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
  // Whether the briefing stage runs before generation, and — once it is
  // running — the brief it is asking about
  const [askFirst, setAskFirst] = useState(isBriefingStageEnabled)
  const [briefing, setBriefing] = useState<string | null>(null)
  // How closely this generation follows the corpus grounding it (story 8.21)
  const [fidelity, setFidelity] = useState<StyleFidelity>(getStyleFidelity)
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

  const handleBriefingToggled = (enabled: boolean) => {
    setAskFirst(enabled)
    setBriefingStageEnabled(enabled)
  }

  const handleFidelityChanged = (value: string) => {
    const chosen = parseStyleFidelity(value)
    setFidelity(chosen)
    setStyleFidelity(chosen)
  }

  // A generic generation leans on the corpus having been read for what is
  // particular to it: without that reading the devices are sent as they were
  // written, cue words and all, and only the standing instruction keeps them
  // out of the script
  const fidelityHelp = fidelity === 'generic'
    ? areActiveDevicesGeneralised()
      ? 'The corpus\'s moves, written without its own names and trigger words.'
      : 'The corpus\'s moves, without its own names and trigger words. Read the ' +
        'active folder for devices to have them marked rather than inferred.'
    : 'Written in the corpus\'s devices as they were read, cue words and names and all.'

  // `briefedPrompt` is what the model is asked to write from: the typed brief,
  // or the typed brief with the briefing answers appended. The title still
  // comes from what the user actually typed.
  const startGeneration = async (briefedPrompt: string) => {
    if (!briefedPrompt.trim()) return

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
        initialPrompt: briefedPrompt,
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
        prompt: briefedPrompt,
        conversationId: conversation.id,
        targetMinutes
      })

    } catch (error) {
      console.error('Failed to queue script generation:', error)
    }
  }

  // The composer's submit: with the briefing stage on, the questions come
  // first and generation starts from whatever they add to the brief
  const handleSubmit = () => {
    if (!prompt.trim()) return

    if (askFirst) {
      setBriefing(prompt.trim())
      return
    }
    void startGeneration(prompt)
  }

  return (
    <>
      {!briefing && (
        <section>
          <h2>What script should we generate?</h2>
        </section>
      )}

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

      {briefing ? (
        <BriefingStage
          brief={briefing}
          onReady={(briefedPrompt) => {
            setBriefing(null)
            void startGeneration(briefedPrompt)
          }}
          onBack={() => setBriefing(null)}
        />
      ) : (
        <section>
          <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
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
                <label className="briefing-toggle" htmlFor="ask-first">
                  <input
                    id="ask-first"
                    type="checkbox"
                    checked={askFirst}
                    onChange={(e) => handleBriefingToggled(e.target.checked)}
                  />
                  <span>Ask me questions first</span>
                </label>
                <label className="fidelity-choice" htmlFor="style-fidelity">
                  <span>Corpus style</span>
                  <select
                    id="style-fidelity"
                    value={fidelity}
                    onChange={(e) => handleFidelityChanged(e.target.value)}
                    aria-describedby="style-fidelity-help"
                  >
                    <option value="faithful">Faithful</option>
                    <option value="generic">Generic</option>
                  </select>
                </label>
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!prompt.trim() || !!providerWarning}
                  aria-label="Generate script"
                >
                  <ArrowUp size={24} />
                </button>
              </div>
              <p className="fidelity-help" id="style-fidelity-help">
                {fidelityHelp}
              </p>
            </div>
          </form>
        </section>
      )}

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
