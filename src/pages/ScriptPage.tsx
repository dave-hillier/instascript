import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { TokenUsageBar } from '../components/TokenUsageBar'
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

// Build document from multi-generation conversation
// Generation 0 = outline, Generations 1..N = sections
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

  // First generation is the outline - extract title from it
  const outlineGeneration = conversation.generations[0]
  const { title: documentTitle } = parseSections(outlineGeneration.response)

  // Subsequent generations are individual sections
  const consolidatedSections: ScriptDocumentSection[] = []

  for (let i = 1; i < conversation.generations.length; i++) {
    const generation = conversation.generations[i]
    const { sections: genSections } = parseSections(generation.response)

    for (const section of genSections) {
      const existingIndex = consolidatedSections.findIndex(s => s.title === section.title)
      if (existingIndex >= 0) {
        consolidatedSections[existingIndex] = section
      } else {
        consolidatedSections.push(section)
      }
    }
  }

  // Apply live updates during streaming
  const sectionsWithLiveUpdates = consolidatedSections.map(section => {
    const isSectionRegenerating = conversation && currentGeneration &&
      currentGeneration.conversationId === conversation.id &&
      !currentGeneration.isComplete &&
      currentGeneration.sectionTitle === section.title

    if (isSectionRegenerating) {
      const liveContent = conversation.generations[conversation.generations.length - 1]?.response || ''
      const { sections: liveSections } = parseSections(liveContent)
      if (liveSections.length > 0) {
        return { ...section, content: liveSections[0].content, wordCount: liveSections[0].wordCount }
      }
      return section
    }
    return section
  })

  // Check if a new section is currently streaming (not yet in consolidated)
  if (currentGeneration &&
      currentGeneration.conversationId === conversation.id &&
      !currentGeneration.isComplete &&
      currentGeneration.sectionTitle) {
    const alreadyExists = sectionsWithLiveUpdates.some(s => s.title === currentGeneration.sectionTitle)
    if (!alreadyExists) {
      const liveResponse = conversation.generations[conversation.generations.length - 1]?.response || ''
      const { sections: liveSections } = parseSections(liveResponse)
      if (liveSections.length > 0) {
        sectionsWithLiveUpdates.push(liveSections[0])
      }
    }
  }

  const isConversationGenerating = conversation && currentGeneration ?
    currentGeneration.conversationId === conversation.id && !currentGeneration.isComplete : false

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

const TARGET_WORDS_PER_SECTION = 400

interface WordCountMeterProps {
  sections: ScriptDocumentSection[]
  generationMachine: {
    phase: string
    currentSectionIndex: number
    totalSections: number
    sectionWordCounts: number[]
    outline: { sections: { title: string }[] } | null
  } | null
}

const WordCountMeter = ({ sections, generationMachine }: WordCountMeterProps) => {
  const totalWords = sections.reduce((sum, s) => sum + s.wordCount, 0)

  // During generation, use the outline to show planned sections
  const plannedSections = generationMachine?.outline?.sections ?? []
  const displaySections = plannedSections.length > 0 ? plannedSections : sections

  if (displaySections.length === 0 && !generationMachine) return null

  return (
    <aside aria-label="Word count breakdown">
      <div className="word-meter">
        <div className="word-meter-header">
          <span>Word count</span>
          <span>{totalWords} total</span>
        </div>
        <div className="word-meter-bars">
          {displaySections.map((displaySection, i) => {
            const title = 'title' in displaySection ? displaySection.title : ''
            const matchingSection = sections.find(s => s.title === title)
            const wordCount = matchingSection?.wordCount ?? 0
            const fillPercent = Math.min(100, (wordCount / TARGET_WORDS_PER_SECTION) * 100)

            const isCurrentlyGenerating = generationMachine &&
              generationMachine.phase === 'generating_section' &&
              generationMachine.currentSectionIndex === i

            const isPending = generationMachine &&
              generationMachine.phase === 'generating_section' &&
              i > generationMachine.currentSectionIndex &&
              wordCount === 0

            let barState = 'complete'
            if (isCurrentlyGenerating) barState = 'active'
            else if (isPending) barState = 'pending'
            else if (wordCount === 0) barState = 'empty'

            return (
              <div key={title || i} className="word-meter-row" data-state={barState}>
                <span className="word-meter-label">{title || `Section ${i + 1}`}</span>
                <div className="word-meter-track">
                  <div
                    className="word-meter-fill"
                    style={{ width: `${fillPercent}%` }}
                    role="progressbar"
                    aria-valuenow={wordCount}
                    aria-valuemin={0}
                    aria-valuemax={TARGET_WORDS_PER_SECTION}
                    aria-label={`${title}: ${wordCount} words`}
                  />
                  <span className="word-meter-target" />
                </div>
                <span className="word-meter-count">{wordCount}</span>
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

interface ScriptPageProps {
  showSectionTitles?: boolean
}

export const ScriptPage = ({ showSectionTitles = true }: ScriptPageProps) => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state } = useAppContext()
  const { state: conversationState, getConversationByScriptId, regenerateSection, stopGeneration } = useConversationContext()

  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  const generationMachine = conversationState.generationMachine

  // Get structured document and generation state
  const document = getScriptDocument(conversation, currentGeneration)
  const generationState = {
    isGenerating: document.isGenerating,
    shouldDisableRegenerate: document.isGenerating,
    error: currentGeneration?.error
  }

  const isThisConversation = conversation && generationMachine &&
    generationMachine.conversationId === conversation.id

  const phaseLabel = isThisConversation
    ? generationMachine.phase === 'generating_outline'
      ? 'Drafting outline...'
      : generationMachine.phase === 'generating_section'
        ? `Writing section ${generationMachine.currentSectionIndex + 1} of ${generationMachine.totalSections}...`
        : generationMachine.phase === 'complete'
          ? 'Complete'
          : generationMachine.phase === 'error'
            ? 'Error'
            : 'Generating...'
    : 'Generating...'


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
          onClick={() => navigate('/')}
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
          <div>
            <p>{phaseLabel}</p>
            <button
              onClick={stopGeneration}
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

      <WordCountMeter
        sections={document.sections}
        generationMachine={isThisConversation ? generationMachine : null}
      />

      <TokenUsageBar conversation={conversation} />

      <article>
        {document.sections.length > 0 ? (
          document.sections.map((section, index) => (
            <section key={`section-${index}`}>
              {showSectionTitles && (
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
              )}
              <div>
                {section.content
                  .split('\n')
                  .map((line, lineIndex) => ({ text: line, key: `line-${lineIndex}` }))
                  .filter(({ text }) => !text.startsWith('## ') && text.trim())
                  .map(({ text, key }) => (
                    <p key={key}>{text}</p>
                  ))}
              </div>
            </section>
          ))
        ) : document.fullContent ? (
          document.fullContent
            .split('\n')
            .map((paragraph, paragraphIndex) => ({ text: paragraph, key: `paragraph-${paragraphIndex}` }))
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
