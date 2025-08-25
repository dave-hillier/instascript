import { Archive, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAppContext } from '../hooks/useAppContext'
import type { Script } from '../types/script'

type ScriptListProps = {
  scripts: Script[]
  showArchived?: boolean
}

export const ScriptList = ({ scripts, showArchived = false }: ScriptListProps) => {
  const navigate = useNavigate()
  const { state: appState, dispatch: appDispatch } = useAppContext()

  const handleArchiveScript = (scriptId: string) => {
    appDispatch({ type: 'ARCHIVE_SCRIPT', scriptId })
  }

  const handleDeleteScript = (scriptId: string) => {
    if (window.confirm('Are you sure you want to delete this script? This action cannot be undone.')) {
      appDispatch({ type: 'DELETE_SCRIPT', scriptId })
    }
  }

  const renderScriptItem = (script: Script) => (
    <li 
      key={script.id}
      onMouseEnter={() => appDispatch({ type: 'SET_HOVER', scriptId: script.id })}
      onMouseLeave={() => appDispatch({ type: 'SET_HOVER', scriptId: null })}
    >
      <div 
        onClick={() => navigate(`/script/${script.id}`)}
        style={{ cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            navigate(`/script/${script.id}`)
          }
        }}
        aria-label={`View script: ${script.title}`}
      >
        <h3>{script.title}</h3>
        <div>{script.createdAt} · Generated Markdown</div>
      </div>
      {script.comments && (
        <div aria-label={`${script.comments} comments`}>{script.comments}</div>
      )}
      {script.status && (
        <div aria-label={`Status: ${script.status}`}>{script.status}</div>
      )}
      {script.length && (
        <div aria-label={`Script length: ${script.length}`}>{script.length}</div>
      )}
      {appState.hoveredScript === script.id && (
        <div className="script-actions">
          <button
            onClick={() => handleArchiveScript(script.id)}
            aria-label={script.isArchived ? 'Unarchive script' : 'Archive script'}
            type="button"
          >
            <Archive size={16} />
          </button>
          <button
            onClick={() => handleDeleteScript(script.id)}
            aria-label="Delete script"
            type="button"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </li>
  )

  if (scripts.length === 0) {
    return <p>No {showArchived ? 'archived ' : ''}scripts found.</p>
  }

  return (
    <ul>
      {scripts.map(renderScriptItem)}
    </ul>
  )
}