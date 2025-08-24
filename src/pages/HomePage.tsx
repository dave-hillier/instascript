import { useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { ScriptList } from '../components/ScriptList'

type Tab = 'scripts' | 'archive'

export const HomePage = () => {
  const [activeTab, setActiveTab] = useState<Tab>('scripts')
  const { activeScripts, archivedScripts } = useAppContext()

  const filteredScripts = activeTab === 'scripts' ? activeScripts : archivedScripts

  return (
    <>
      <section>
        <h2>What script should we generate?</h2>
      </section>
      
      <section>
        <form>
          <textarea 
            placeholder="Describe a script to generate"
            aria-label="Script description"
          />
          <div>
            <div>
            </div>
            <div>
              <button type="submit">
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
            onClick={() => setActiveTab('scripts')}
            type="button"
          >
            Scripts
          </button>
          <button 
            role="tab"
            aria-selected={activeTab === 'archive'}
            aria-controls="archive-panel"
            id="archive-tab"
            onClick={() => setActiveTab('archive')}
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