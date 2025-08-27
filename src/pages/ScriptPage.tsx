import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import type { Script } from '../types/script'
import {
  getScriptDocument,
  getScriptGenerationState,
  formatSectionContent,
  formatFullScriptContent
} from '../utils/scriptPageHelpers'

export const ScriptPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state } = useAppContext()
  const { state: conversationState, getConversationByScriptId, regenerateSection } = useConversationContext()
  
  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  
  // Get structured document and generation state
  const document = getScriptDocument(conversation, currentGeneration)
  const generationState = getScriptGenerationState(conversation, currentGeneration)


  const handleRegenerateSection = async (sectionTitle: string) => {
    if (!script || !conversation) return
    
    try {
      await regenerateSection({
        conversationId: conversation.id,
        sectionTitle: sectionTitle
      })
    } catch (error) {
      console.error('Error regenerating section:', error)
    }
  }
  
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
      {generationState.isGenerating && (
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
          {generationState.error && (
            <p role="alert">Error: {generationState.error}</p>
          )}
        </div>
      )}
      
      <article>
        {document.sections.length > 0 ? (
          document.sections.map((section, index) => (
            <section key={`section-${index}`}>
              <header>
                <h2>{section.title}</h2>
                {script.status !== 'in-progress' && conversation && (
                  <button
                    onClick={() => handleRegenerateSection(section.title)}
                    disabled={generationState.shouldDisableRegenerate}
                    aria-label={`${generationState.shouldDisableRegenerate ? 'Regenerating' : 'Regenerate'} ${section.title} section`}
                    type="button"
                  >
                    <RotateCcw size={16} />
                    {generationState.shouldDisableRegenerate ? 'Regenerating...' : 'Regenerate'}
                  </button>
                )}
              </header>
              <div>
                {formatSectionContent(section.content).map(({ text, key }) => (
                  <p key={key}>{text}</p>
                ))}
              </div>
            </section>
          ))
        ) : document.fullContent ? (
          // Fallback for content without clear sections
          formatFullScriptContent(document.fullContent).map(({ text, key }) => (
            <p key={key}>{text}</p>
          ))
        ) : (
          <p>No content yet. Script is being generated...</p>
        )}
      </article>
    </section>
  )
}