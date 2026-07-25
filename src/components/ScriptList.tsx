import { Archive, Copy, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { duplicateScriptStatus } from '../utils/scriptLibrary'
import type { Script } from '../types/script'

type ScriptListProps = {
  scripts: Script[]
  showArchived?: boolean
  searchQuery?: string
}

export const ScriptList = ({ scripts, showArchived = false, searchQuery = '' }: ScriptListProps) => {
  const { dispatch: appDispatch } = useAppContext()
  const { duplicateConversation } = useConversationContext()

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

  const handleDuplicateScript = (e: React.MouseEvent, script: Script) => {
    e.preventDefault()
    const newScriptId = `script_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const conversation = duplicateConversation(script.id, newScriptId)

    const copy: Script = {
      ...script,
      id: newScriptId,
      title: `Copy of ${script.title}`,
      createdAt: new Date().toLocaleDateString(),
      isArchived: false,
      status: duplicateScriptStatus(script),
      conversationId: conversation.id
    }
    appDispatch({ type: 'ADD_SCRIPT', script: copy })
  }

  const renderScriptItem = (script: Script) => {
    const metadata = [script.createdAt, script.status, script.length]
      .filter(Boolean)
      .join(' · ')

    return (
      <li key={script.id}>
        <Link
          to={`/script/${script.id}`}
          aria-label={`View script: ${script.title}`}
        >
          <h3>{script.title}</h3>
          <div>{metadata}</div>
        </Link>
        <div className="script-actions">
          <button
            onClick={(e) => handleDuplicateScript(e, script)}
            aria-label="Duplicate script"
            type="button"
          >
            <Copy size={16} />
          </button>
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
    if (searchQuery.trim()) {
      return <p>No scripts match "{searchQuery.trim()}".</p>
    }
    return <p>No {showArchived ? 'archived ' : ''}scripts found.</p>
  }

  return (
    <ul>
      {scripts.map(renderScriptItem)}
    </ul>
  )
}
