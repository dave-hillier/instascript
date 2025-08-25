import { ArrowUp } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useAppContext } from '../hooks/useAppContext'
import { ScriptList } from '../components/ScriptList'

type Tab = 'scripts' | 'archive'

export const HomePage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeScripts, archivedScripts } = useAppContext()
  
  const activeTab = (searchParams.get('state') === 'archived' ? 'archive' : 'scripts') as Tab

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