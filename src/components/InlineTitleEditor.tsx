import { useState } from 'react'
import { Pencil, Check, X } from 'lucide-react'

interface InlineTitleEditorProps {
  title: string
  onRename: (title: string) => void
}

// Click-to-edit script title for the script page header (story 2.3):
// a pencil button swaps the heading for an input; Enter or the check
// saves, Escape or the cross discards.
export const InlineTitleEditor = ({ title, onRename }: InlineTitleEditorProps) => {
  // null when displaying; the in-progress text while editing
  const [draft, setDraft] = useState<string | null>(null)

  if (draft === null) {
    return (
      <div className="title-editor">
        <h1>{title}</h1>
        <button
          onClick={() => setDraft(title)}
          aria-label="Edit script title"
          type="button"
        >
          <Pencil size={14} />
        </button>
      </div>
    )
  }

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== title) {
      onRename(trimmed)
    }
    setDraft(null)
  }

  return (
    <form
      className="title-editor"
      aria-label="Rename script"
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <label className="sr-only" htmlFor="script-title-input">Script title</label>
      <input
        id="script-title-input"
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
        }}
        autoFocus
      />
      <button type="submit" aria-label="Save title">
        <Check size={16} />
      </button>
      <button type="button" onClick={() => setDraft(null)} aria-label="Cancel renaming">
        <X size={16} />
      </button>
    </form>
  )
}
