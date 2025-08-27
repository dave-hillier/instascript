import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { deriveConversationState, composeFullDocument } from '../utils/responseParser'
import { getSectionContext, extractSectionContent } from '../utils/sectionRegeneration'
import type { Script } from '../types/script'

export const ScriptPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const { state: conversationState, getConversationByScriptId, generateScript } = useConversationContext()
  
  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  
  const [displayContent, setDisplayContent] = useState('')

  // Compose the full document from all generations at render time
  const composedDocument = conversation ? composeFullDocument(conversation) : ''
  const conversationDocument = conversation ? deriveConversationState(conversation) : null

  // Update display content based on generation progress or existing content
  useEffect(() => {
    if (currentGeneration && currentGeneration.conversationId === conversation?.id) {
      setDisplayContent(currentGeneration.content || composedDocument || script?.content || '')
    } else {
      setDisplayContent(composedDocument || script?.content || '')
    }
  }, [currentGeneration, composedDocument, script?.content, conversation?.id])

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

  // Auto-regeneration logic is simplified in the new architecture
  // For now, we disable auto-regeneration as it requires more complex logic
  // to determine which sections need regeneration from raw responses

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

  const handleRegenerateSection = async (sectionTitle: string) => {
    if (!script || !conversation) return
    
    try {
      // Get context about the section and document
      const currentDocument = composeFullDocument(conversation)
      const context = getSectionContext(currentDocument, sectionTitle)
      const currentSectionContent = extractSectionContent(currentDocument, sectionTitle)
      
      // Build context-aware prompt for just the section content
      let prompt = `Generate content for the "${sectionTitle}" section of a hypnosis script`
      
      if (context.documentTitle) {
        prompt += ` titled "${context.documentTitle}"`
      }
      
      prompt += `. Make it at least 400 words and ensure it's engaging and effective.`
      
      // Add context about neighboring sections
      if (context.allSectionTitles.length > 1) {
        const otherSections = context.allSectionTitles.filter(title => title !== sectionTitle)
        prompt += ` The script has these other sections: ${otherSections.join(', ')}.`
        
        if (context.sectionIndex > 0) {
          prompt += ` This section comes after "${context.allSectionTitles[context.sectionIndex - 1]}".`
        }
        if (context.sectionIndex < context.allSectionTitles.length - 1) {
          prompt += ` This section comes before "${context.allSectionTitles[context.sectionIndex + 1]}".`
        }
      }
      
      prompt += ` Focus on creating compelling, effective hypnotic content for just this section. Do not include section headers (##) in your response - just the content.`
      
      if (currentSectionContent) {
        prompt += ` Current content to improve: "${currentSectionContent.substring(0, 300)}${currentSectionContent.length > 300 ? '...' : ''}"`
      }
      
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

  const isGenerating = currentGeneration && currentGeneration.conversationId === conversation?.id && !currentGeneration.isComplete
  const isRegeneratingSection = isGenerating && currentGeneration?.sectionTitle
  
  // With the new architecture, we disable all regeneration during generation
  const shouldDisableRegenerate = isGenerating
  
  // Use parsed sections from the conversation document or fall back to parsing display content
  const sections = conversationDocument?.sections || parseContentSections(displayContent)
  
  // During section regeneration, show the streaming content for that section
  const sectionsWithLiveUpdates = sections.map(section => {
    if (isRegeneratingSection && currentGeneration?.sectionTitle === section.title) {
      return {
        ...section,
        content: currentGeneration.content || section.content
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