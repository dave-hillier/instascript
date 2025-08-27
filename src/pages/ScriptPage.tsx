import { useParams, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { deriveConversationState } from '../utils/responseParser'
import { 
  composeCurrentScript, 
  getCurrentScriptSections,
  isConversationGenerating,
  isSectionRegenerating
} from '../utils/scriptComposition'
import { getSectionRegenerationPrompt } from '../services/prompts'
import type { Script } from '../types/script'

export const ScriptPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const { state: conversationState, getConversationByScriptId, generateScript } = useConversationContext()
  
  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  
  // Compose the current script state from raw conversation
  const currentScript = composeCurrentScript(conversation)
  const conversationDocument = currentScript ? deriveConversationState({ 
    id: '', scriptId: '', generations: [{ messages: [], response: currentScript, timestamp: 0 }], 
    createdAt: 0, updatedAt: 0 
  }) : null

  // Update script content when generation completes
  useEffect(() => {
    if (script && conversation && currentGeneration?.isComplete && currentGeneration.conversationId === conversation.id) {
      const finalContent = composeCurrentScript(conversation)
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

  // Auto-regeneration logic is simplified in the new architecture
  // For now, we disable auto-regeneration as it requires more complex logic
  // to determine which sections need regeneration from raw responses


  const handleRegenerateSection = async (sectionTitle: string) => {
    if (!script || !conversation) return
    
    try {
      // Use the simple section regeneration template
      const prompt = getSectionRegenerationPrompt(sectionTitle)
      
      await generateScript({
        prompt,
        conversationId: conversation.id,
        regenerate: true,
        sectionTitle: sectionTitle
      })
    } catch (error) {
      console.error('Error regenerating section:', error)
    }
  }

  const isGenerating = isConversationGenerating(conversation, currentGeneration)
  const shouldDisableRegenerate = isGenerating
  
  // Get sections from the conversation document or compose from current script
  const sections = conversationDocument?.sections || getCurrentScriptSections(conversation)
  
  // During section regeneration, show live updates for the regenerating section
  const sectionsWithLiveUpdates = sections.map(section => {
    if (isSectionRegenerating(conversation, section.title, currentGeneration)) {
      // Get the latest generation's response as the live section content
      const latestGeneration = conversation?.generations?.[conversation.generations.length - 1]
      const liveContent = latestGeneration?.response || ''
      
      return {
        ...section,
        content: liveContent // Show the live content directly for the section being regenerated
      }
    }
    return section
  })
  
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <p>Generating script...</p>
            <button
              onClick={() => {
                // Stop generation by navigating away or show message
                console.log('Generation stopping not implemented yet')
              }}
              aria-label="Stop script generation"
              type="button"
              className="stop-button-with-text"
            >
              Stop
            </button>
          </div>
          {currentGeneration?.error && (
            <p role="alert">Error: {currentGeneration.error}</p>
          )}
        </div>
      )}
      
      <article>
        {sectionsWithLiveUpdates.length > 0 ? (
          sectionsWithLiveUpdates.map((section, index) => (
            <section key={`section-${index}`}>
              <header>
                <h2>{section.title}</h2>
                {script.status !== 'in-progress' && conversation && (
                  <button
                    onClick={() => handleRegenerateSection(section.title)}
                    disabled={shouldDisableRegenerate || false}
                    aria-label={`${shouldDisableRegenerate ? 'Regenerating' : 'Regenerate'} ${section.title} section`}
                    type="button"
                  >
                    <RotateCcw size={16} />
                    {shouldDisableRegenerate ? 'Regenerating...' : 'Regenerate'}
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
        ) : currentScript ? (
          // Fallback for content without clear sections
          currentScript.split('\n').map((paragraph: string, index: number) => 
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