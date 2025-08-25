import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import type { Script } from '../types/script'

export const ScriptPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state } = useAppContext()
  
  const script = state.scripts.find((s: Script) => s.id === id)
  
  if (!script) {
    return (
      <div>
        <button 
          onClick={() => navigate(-1)}
          aria-label="Go back"
          type="button"
        >
          <ArrowLeft size={18} />
          Back
        </button>
        <h1>Script not found</h1>
        <p>The script you're looking for doesn't exist.</p>
      </div>
    )
  }
    
  return (
    <section>      
      <article>
        {script.content.split('\n').map((paragraph: string, index: number) => (
          paragraph.trim() ? (
            <p key={index}>{paragraph}</p>
          ) : (
            <br key={index} />
          )
        ))}
      </article>
    </section>
  )
}