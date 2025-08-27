import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import type { Script } from '../types/script'
import type { RawConversation } from '../types/conversation'

interface ScriptDocumentSection {
  id: string
  title: string
  content: string
  wordCount: number
}

interface ScriptDocument {
  title?: string
  sections: ScriptDocumentSection[]
  fullContent: string
  isGenerating: boolean
  hasError: boolean
  errorMessage?: string
}

interface CurrentGeneration {
  conversationId: string
  isComplete: boolean
  error?: string
  sectionTitle?: string
}

// Parse sections from script content
const parseSections = (scriptContent: string): { title?: string; sections: ScriptDocumentSection[] } => {
  const lines = scriptContent.split('\n')
  const firstLine = lines[0]
  const titleMatch = firstLine.match(/^#\s+(.+)$/)
  const documentTitle = titleMatch ? titleMatch[1].trim() : undefined

  const sections: ScriptDocumentSection[] = []
  let currentSectionStart = -1
  let currentSectionTitle = ''
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    if (line.match(/^##\s+/)) {
      // Complete previous section
      if (currentSectionStart >= 0 && currentSectionTitle) {
        const sectionContent = lines.slice(currentSectionStart + 1, i).join('\n').trim()
        const wordCount = sectionContent.trim().split(/\s+/).filter(word => word.length > 0).length
        sections.push({
          id: `section_${currentSectionTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          title: currentSectionTitle,
          content: sectionContent,
          wordCount
        })
      }
      
      // Start new section
      currentSectionStart = i
      currentSectionTitle = line.match(/##\s+(.+?)$/)?.[1]?.trim() || ''
    }
  }
  
  // Handle last section
  if (currentSectionStart >= 0 && currentSectionTitle) {
    const sectionContent = lines.slice(currentSectionStart + 1).join('\n').trim()
    const wordCount = sectionContent.trim().split(/\s+/).filter(word => word.length > 0).length
    sections.push({
      id: `section_${currentSectionTitle.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      title: currentSectionTitle,
      content: sectionContent,
      wordCount
    })
  }

  return { title: documentTitle, sections }
}

// Improved script document parsing with multi-generation support
const getScriptDocument = (
  conversation: RawConversation | undefined,
  currentGeneration: CurrentGeneration | null
): ScriptDocument => {
  if (!conversation?.generations?.length) {
    return {
      sections: [],
      fullContent: '',
      isGenerating: false,
      hasError: !!currentGeneration?.error,
      errorMessage: currentGeneration?.error
    }
  }

  // Start with the first generation as the base document
  const baseGeneration = conversation.generations[0]
  const { title: documentTitle, sections: baseSections } = parseSections(baseGeneration.response)

  // Apply subsequent generations as section replacements
  let consolidatedSections = [...baseSections]
  
  for (let i = 1; i < conversation.generations.length; i++) {
    const generation = conversation.generations[i]
    const { sections: replacementSections } = parseSections(generation.response)
    
    // Each subsequent generation should contain only one section
    for (const replacementSection of replacementSections) {
      const existingIndex = consolidatedSections.findIndex(
        section => section.title === replacementSection.title
      )
      
      if (existingIndex >= 0) {
        // Replace existing section
        consolidatedSections[existingIndex] = replacementSection
      } else {
        // Add new section if not found (shouldn't happen in normal flow)
        consolidatedSections.push(replacementSection)
      }
    }
  }

  // Apply live updates during section regeneration
  const sectionsWithLiveUpdates = consolidatedSections.map(section => {
    const isSectionRegenerating = conversation && currentGeneration && 
      currentGeneration.conversationId === conversation.id && 
      !currentGeneration.isComplete && 
      currentGeneration.sectionTitle === section.title

    if (isSectionRegenerating) {
      const liveContent = conversation.generations[conversation.generations.length - 1]?.response || ''
      return { ...section, content: liveContent }
    }
    return section
  })

  const isConversationGenerating = conversation && currentGeneration ? 
    currentGeneration.conversationId === conversation.id && !currentGeneration.isComplete : false

  // Reconstruct full content from consolidated sections
  const fullContent = [
    documentTitle ? `# ${documentTitle}` : '',
    ...sectionsWithLiveUpdates.map(section => `## ${section.title}\n${section.content}`)
  ].filter(Boolean).join('\n\n')

  return {
    title: documentTitle,
    sections: sectionsWithLiveUpdates,
    fullContent,
    isGenerating: isConversationGenerating,
    hasError: !!currentGeneration?.error,
    errorMessage: currentGeneration?.error
  }
}

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
  const generationState = {
    isGenerating: document.isGenerating,
    shouldDisableRegenerate: document.isGenerating,
    error: currentGeneration?.error
  }


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
                {!generationState.shouldDisableRegenerate && conversation && (
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
                {section.content
                  .split('\n')
                  .map((line, index) => ({ text: line, key: `line-${index}` }))
                  .filter(({ text }) => !text.startsWith('## ') && text.trim())
                  .map(({ text, key }) => (
                    <p key={key}>{text}</p>
                  ))}
              </div>
            </section>
          ))
        ) : document.fullContent ? (
          // Fallback for content without clear sections
          document.fullContent
            .split('\n')
            .map((paragraph, index) => ({ text: paragraph, key: `paragraph-${index}` }))
            .filter(({ text }) => text.trim())
            .map(({ text, key }) => (
              <p key={key}>{text}</p>
            ))
        ) : (
          <p>No content yet. Script is being generated...</p>
        )}
      </article>
    </section>
  )
}