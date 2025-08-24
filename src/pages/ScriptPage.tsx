import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Calendar, Tag, Clock, FileText } from 'lucide-react'
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
          onClick={() => navigate('/')}
          aria-label="Go back to homepage"
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
  
  const wordCount = script.content.split(/\s+/).filter((word: string) => word.length > 0).length
  const estimatedReadTime = Math.max(1, Math.round(wordCount / 200)) // 200 words per minute
  
  return (
    <div>
      <section>
        <div>
          <div>
            <Calendar size={16} />
            <span>{new Date(script.createdAt).toLocaleDateString()}</span>
          </div>
          
          {script.status && (
            <div>
              <FileText size={16} />
              <span>{script.status}</span>
            </div>
          )}
          
          <div>
            <Clock size={16} />
            <span>{estimatedReadTime} min read</span>
          </div>
          
          <div>
            <FileText size={16} />
            <span>{wordCount} words</span>
          </div>
        </div>
        
        {script.tags && script.tags.length > 0 && (
          <div>
            <Tag size={16} />
            <div>
              {script.tags.map((tag: string) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </div>
        )}
      </section>
      
      <article>
        <div>
          {script.content.split('\n').map((paragraph: string, index: number) => (
            paragraph.trim() ? (
              <p key={index}>{paragraph}</p>
            ) : (
              <br key={index} />
            )
          ))}
        </div>
      </article>
    </div>
  )
}