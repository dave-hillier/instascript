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
    <section>
      <header>
        <dl>
          <dt>
            <Calendar size={16} />
            <span>Created</span>
          </dt>
          <dd>{new Date(script.createdAt).toLocaleDateString()}</dd>
          
          {script.status && (
            <>
              <dt>
                <FileText size={16} />
                <span>Status</span>
              </dt>
              <dd>{script.status}</dd>
            </>
          )}
          
          <dt>
            <Clock size={16} />
            <span>Reading time</span>
          </dt>
          <dd>{estimatedReadTime} min read</dd>
          
          <dt>
            <FileText size={16} />
            <span>Length</span>
          </dt>
          <dd>{wordCount} words</dd>
        </dl>
        
        {script.tags && script.tags.length > 0 && (
          <aside>
            <Tag size={16} />
            <span>Tags:</span>
            <ul>
              {script.tags.map((tag: string) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </aside>
        )}
      </header>
      
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