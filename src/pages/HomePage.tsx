import { ArrowUp } from 'lucide-react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { ScriptList } from '../components/ScriptList'
import type { Script } from '../types/script'

type Tab = 'scripts' | 'archive'

export const HomePage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [prompt, setPrompt] = useState('')
  const navigate = useNavigate()
  
  const { activeScripts, archivedScripts, dispatch: appDispatch } = useAppContext()
  const { createConversation, generateScript } = useConversationContext()
  
  const activeTab = (searchParams.get('state') === 'archived' ? 'archive' : 'scripts') as Tab
  const filteredScripts = activeTab === 'scripts' ? activeScripts : archivedScripts

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
        status: 'in-progress'
      }

      // Create conversation
      const conversation = createConversation(scriptId, prompt)
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
        conversationId: conversation.id
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
            </div>
            <div>
              <button 
                type="button"
                onClick={handleGenerate}
                disabled={!prompt.trim()}
                aria-label="Generate script"
              >
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
            aria-selected={activeTab === 'scripts'}
            aria-controls="scripts-panel"
            id="scripts-tab"
            onClick={() => setSearchParams({})}
            type="button"
          >
            Scripts
          </button>
          <button 
            role="tab"
            aria-selected={activeTab === 'archive'}
            aria-controls="archive-panel"
            id="archive-tab"
            onClick={() => setSearchParams({ state: 'archived' })}
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
          scripts={filteredScripts} 
          showArchived={activeTab === 'archive'} 
        />
      </section>
    </>
  )
}