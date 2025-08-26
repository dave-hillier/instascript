import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { useJobQueue } from '../hooks/useJobQueue'
import { scriptRegenerationServiceV2 } from '../services/scriptRegenerationServiceV2'
import type { Script } from '../types/script'

export const ScriptPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const { state: conversationState, getConversationByScriptId } = useConversationContext()
  const { state: jobQueueState } = useJobQueue()
  
  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  
  const [displayContent, setDisplayContent] = useState('')

  // Update display content based on generation progress or existing content
  useEffect(() => {
    if (currentGeneration && currentGeneration.conversationId === conversation?.id) {
      setDisplayContent(currentGeneration.content || script?.content || '')
    } else {
      setDisplayContent(script?.content || '')
    }
  }, [currentGeneration, script?.content, conversation?.id])

  // Update script content when generation completes
  useEffect(() => {
    if (script && conversation && currentGeneration?.isComplete && currentGeneration.conversationId === conversation.id) {
      const finalContent = currentGeneration.content || ''
      if (finalContent && finalContent !== script.content) {
        dispatch({
          type: 'UPDATE_SCRIPT',
          scriptId: script.id,
          updates: { 
            content: finalContent,
            status: currentGeneration.error ? 'draft' : 'complete'
          }
        })
      }
    }
  }, [currentGeneration, script, conversation, dispatch])

  const parseContentSections = (content: string) => {
    if (!content) return []
    
    const sections = content.split(/(?=^##\s)/gm).filter(section => section.trim())
    return sections.map((sectionContent, index) => {
      const titleMatch = sectionContent.match(/^##\s+(.+?)(?=\n|$)/)
      const title = titleMatch ? titleMatch[1].trim() : `Section ${index + 1}`
      const id = `section_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
      
      return {
        id,
        title,
        content: sectionContent.trim()
      }
    })
  }

  const handleRegenerateSection = (sectionId: string, sectionTitle: string) => {
    if (!script || !conversation) return
    
    // Use the regeneration service to handle the request
    scriptRegenerationServiceV2.requestManualRegeneration(
      script.id,
      sectionId,
      sectionTitle,
      conversation.id
    )
  }

  const isGenerating = currentGeneration && currentGeneration.conversationId === conversation?.id && !currentGeneration.isComplete
  
  // Check if a section is currently being regenerated
  const isSectionRegenerating = (sectionId: string) => {
    return jobQueueState.jobs.some(job => 
      job.type === 'regenerate-section' && 
      job.sectionId === sectionId && 
      (job.status === 'queued' || job.status === 'processing')
    )
  }
  
  // Check if regenerate buttons should be disabled (only disable the specific section)
  const shouldDisableRegenerate = (sectionId: string) => {
    return isSectionRegenerating(sectionId)
  }
  
  // Use conversation sections if available, otherwise parse from content
  const sections = conversation && conversation.sections.length > 0 
    ? conversation.sections.map(section => {
        // During regeneration, show streaming content for the section being regenerated
        if (isGenerating && currentGeneration?.sectionId === section.id) {
          return {
            id: section.id,
            title: section.title,
            content: currentGeneration.content || section.content
          }
        }
        return {
          id: section.id,
          title: section.title,
          content: section.content
        }
      })
    : parseContentSections(displayContent)
  
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
      {isGenerating && (
        <div role="status" aria-live="polite">
          <p>Generating script...</p>
          {currentGeneration?.error && (
            <p role="alert">Error: {currentGeneration.error}</p>
          )}
        </div>
      )}
      
      <article>
        {sections.length > 0 ? (
          sections.map((section) => (
            <section key={section.id}>
              <header>
                <h2>{section.title}</h2>
                {script.status !== 'in-progress' && conversation && (
                  <button
                    onClick={() => handleRegenerateSection(section.id, section.title)}
                    disabled={shouldDisableRegenerate(section.id)}
                    aria-label={`${shouldDisableRegenerate(section.id) ? 'Regenerating' : 'Regenerate'} ${section.title} section`}
                    type="button"
                  >
                    <RotateCcw size={16} />
                    {shouldDisableRegenerate(section.id) ? 'Regenerating...' : 'Regenerate'}
                  </button>
                )}
              </header>
              <div>
                {section.content.split('\n').map((line: string, index: number) => {
                  if (line.startsWith('## ')) {
                    return null // Skip the header as it's already displayed
                  }
                  return line.trim() ? (
                    <p key={index}>{line}</p>
                  ) : null
                })}
              </div>
            </section>
          ))
        ) : displayContent ? (
          // Fallback for content without clear sections
          displayContent.split('\n').map((paragraph: string, index: number) => 
            paragraph.trim() ? (
              <p key={index}>{paragraph}</p>
            ) : null
          )
        ) : (
          <p>No content yet. Script is being generated...</p>
        )}
      </article>
    </section>
  )
}