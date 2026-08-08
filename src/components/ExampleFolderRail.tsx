import { useState } from 'react'
import { Archive, Folder, FolderOpen, FolderPlus } from 'lucide-react'

// One row of the rail: a folder of the user's own material, or the bundled
// set, which browses the same way but cannot be written to
export interface RailFolder {
  name: string
  count: number
  // Whether this is the folder generation draws on. One folder is, always.
  grounding: boolean
}

interface ExampleFolderRailProps {
  folders: RailFolder[]
  bundled: { count: number; enabled: boolean } | null
  // What the listing beside the rail is showing: a folder by name, or the
  // bundled set
  viewing: string | null
  onFolderViewed: (folder: string) => void
  onBundledViewed: () => void
  onFolderCreated: (name: string) => void
}

// Makes an empty folder, ready to be imported into or filed into. Folders are
// otherwise implied by the examples in them, which leaves no way to set one up
// before there is anything to put in it.
const NewFolderForm = ({
  onFolderCreated
}: {
  onFolderCreated: (name: string) => void
}) => {
  const [name, setName] = useState('')

  return (
    <form
      className="example-new-folder"
      aria-label="Create a folder"
      onSubmit={event => {
        event.preventDefault()
        if (!name.trim()) return
        onFolderCreated(name)
        setName('')
      }}
    >
      <label className="sr-only" htmlFor="new-folder-name">
        New folder name
      </label>
      <input
        id="new-folder-name"
        type="text"
        value={name}
        onChange={event => setName(event.target.value)}
        placeholder="New folder"
      />
      <button type="submit" aria-label="Create folder">
        <FolderPlus size={14} />
      </button>
    </form>
  )
}

// The corpus's folders, listed down the side the way a file browser lists
// them: browsing a folder is just looking at it, and which folder grounds
// generation is a separate, single choice marked here and made in the listing.
export const ExampleFolderRail = ({
  folders,
  bundled,
  viewing,
  onFolderViewed,
  onBundledViewed,
  onFolderCreated
}: ExampleFolderRailProps) => (
  <nav className="example-rail" aria-label="Corpus folders">
    <ul>
      {folders.map(folder => {
        const open = viewing === folder.name
        return (
          <li key={folder.name} data-grounding={folder.grounding}>
            <button
              type="button"
              aria-current={open ? 'true' : undefined}
              onClick={() => onFolderViewed(folder.name)}
            >
              {open ? (
                <FolderOpen size={15} aria-hidden="true" />
              ) : (
                <Folder size={15} aria-hidden="true" />
              )}
              <span className="example-rail-name">{folder.name}</span>
              {folder.grounding && (
                <span className="sr-only">, grounding generation</span>
              )}
              <span className="example-rail-count">{folder.count}</span>
            </button>
          </li>
        )
      })}
      {bundled && (
        <li className="example-rail-bundled">
          <button
            type="button"
            aria-current={viewing === null ? 'true' : undefined}
            onClick={onBundledViewed}
          >
            <Archive size={15} aria-hidden="true" />
            <span className="example-rail-name">Bundled</span>
            {!bundled.enabled && <span className="sr-only">, switched off</span>}
            <span className="example-rail-count">{bundled.count}</span>
          </button>
        </li>
      )}
    </ul>
    <NewFolderForm onFolderCreated={onFolderCreated} />
  </nav>
)
