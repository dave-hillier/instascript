import { Archive, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../hooks/useAppContext'
import type { Script } from '../types/script'

type ScriptListProps = {
  scripts: Script[]
  showArchived?: boolean
}

export const ScriptList = ({ scripts, showArchived = false }: ScriptListProps) => {
  const { dispatch: appDispatch } = useAppContext()

  const handleArchiveScript = (e: React.MouseEvent, scriptId: string) => {
    e.preventDefault()
    appDispatch({ type: 'ARCHIVE_SCRIPT', scriptId })
  }

  const handleDeleteScript = (e: React.MouseEvent, scriptId: string) => {
    e.preventDefault()
    if (window.confirm('Are you sure you want to delete this script? This action cannot be undone.')) {
      appDispatch({ type: 'DELETE_SCRIPT', scriptId })
    }
  }

  const renderScriptItem = (script: Script) => {
    return (
      <li key={script.id}>
        <Link
          to={`/script/${script.id}`}
          aria-label={`View script: ${script.title}`}
        >
          <h3>{script.title}</h3>
          <div>{script.createdAt} · Generated Markdown</div>
        </Link>
        {script.comments && (
          <div aria-label={`${script.comments} comments`}>{script.comments}</div>
        )}
        {script.status && (
          <div aria-label={`Status: ${script.status}`}>{script.status}</div>
        )}
        {script.length && (
          <div aria-label={`Script length: ${script.length}`}>{script.length}</div>
        )}
        <div className="script-actions">
          <button
            onClick={(e) => handleArchiveScript(e, script.id)}
            aria-label={script.isArchived ? 'Unarchive script' : 'Archive script'}
            type="button"
          >
            <Archive size={16} />
          </button>
          <button
            onClick={(e) => handleDeleteScript(e, script.id)}
            aria-label="Delete script"
            type="button"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </li>
    )
  }

  if (scripts.length === 0) {
    return <p>No {showArchived ? 'archived ' : ''}scripts found.</p>
  }

  return (
    <ul>
      {scripts.map(renderScriptItem)}
    </ul>
  )
}