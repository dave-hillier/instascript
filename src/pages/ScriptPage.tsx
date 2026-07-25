import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowUp, BookmarkPlus, Check, Pencil, Play, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { TokenUsageBar } from '../components/TokenUsageBar'
import { PerformanceMode } from '../components/PerformanceMode'
import { extractDocumentTitle } from '../utils/scriptMetrics'
import { getAllExamples, promoteScriptToExample } from '../services/exampleCorpus'
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

  // Outline generations start with a document-level "# Title" heading; section
  // generations start with "## Section". A retried conversation can contain a
  // fresh outline after earlier sections, so the last outline's title wins and
  // outline bodies (plans, not script prose) are excluded from consolidation.
  let documentTitle: string | undefined
  const consolidatedSections: ScriptDocumentSection[] = []

  for (const generation of conversation.generations) {
    const isOutline = /^#(?!#)/.test(generation.response.trimStart())

    if (isOutline) {
      documentTitle = extractDocumentTitle(generation.response) ?? documentTitle
      continue
    }

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
  performanceMode?: boolean
  onExitPerformanceMode?: () => void
}

export const ScriptPage = ({
  showSectionTitles = true,
  performanceMode = false,
  onExitPerformanceMode
}: ScriptPageProps) => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { state } = useAppContext()
  const {
    state: conversationState,
    isLoaded: conversationsLoaded,
    getConversationByScriptId,
    createConversation,
    generateScript,
    regenerateSection,
    refineScript,
    editSection,
    stopGeneration
  } = useConversationContext()

  // Which section's regenerate-with-instructions form is open, and its text
  const [instructionTarget, setInstructionTarget] = useState<string | null>(null)
  const [instructionText, setInstructionText] = useState('')
  // Which section is being manually edited, and its draft text
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [refineInstruction, setRefineInstruction] = useState('')
  const [promotedToExamples, setPromotedToExamples] = useState(false)

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

  // Section regeneration and whole-script refinement run without the outline
  // state machine, so fall back to the current generation for their labels
  const phaseLabel = isThisConversation && generationMachine.phase === 'generating_outline'
    ? 'Drafting outline...'
    : isThisConversation && generationMachine.phase === 'generating_section'
      ? `Writing section ${generationMachine.currentSectionIndex + 1} of ${generationMachine.totalSections}...`
      : currentGeneration && !currentGeneration.isComplete
        ? currentGeneration.sectionTitle
          ? `Rewriting "${currentGeneration.sectionTitle}"...`
          : 'Refining script...'
        : 'Generating...'


  // A failed generation stays visible after the generating flag clears
  const persistentErrorMessage = !generationState.isGenerating && conversation
    ? (generationMachine?.conversationId === conversation.id && generationMachine.phase === 'error'
        ? generationMachine.error ?? 'Unknown error'
        : currentGeneration?.conversationId === conversation.id && currentGeneration.error
          ? currentGeneration.error
          : undefined)
    : undefined

  // A script left 'in-progress' by a closed or refreshed tab, with nothing running now
  const wasInterrupted = script
    ? state.interruptedScriptIds.includes(script.id) &&
      !generationState.isGenerating &&
      !persistentErrorMessage
    : false

  const handleRetry = async () => {
    if (!script) return

    const prompt = script.initialPrompt ?? script.title
    const conversationId = conversation?.id ?? createConversation(script.id).id

    try {
      await generateScript({ prompt, conversationId })
    } catch (error) {
      console.error('Error retrying generation:', error)
    }
  }

  const handleRegenerateSection = async (sectionTitle: string, instruction?: string) => {
    if (!script || !conversation) return

    try {
      await regenerateSection({
        conversationId: conversation.id,
        sectionTitle: sectionTitle,
        instruction
      })
    } catch (error) {
      console.error('Error regenerating section:', error)
    }
  }

  const handleToggleInstructionForm = (sectionTitle: string) => {
    setInstructionText('')
    setInstructionTarget(current => current === sectionTitle ? null : sectionTitle)
  }

  const handleStartEdit = (sectionTitle: string, content: string) => {
    setInstructionTarget(null)
    setEditTarget(sectionTitle)
    setEditDraft(content)
  }

  const handleCancelEdit = () => {
    setEditTarget(null)
    setEditDraft('')
  }

  const handleEditSubmit = (event: React.FormEvent, sectionTitle: string) => {
    event.preventDefault()
    if (!conversation || !editDraft.trim()) return

    try {
      editSection({
        conversationId: conversation.id,
        sectionTitle,
        content: editDraft
      })
    } catch (error) {
      console.error('Error saving section edit:', error)
      return
    }
    setEditTarget(null)
    setEditDraft('')
  }

  const handleInstructionSubmit = async (event: React.FormEvent, sectionTitle: string) => {
    event.preventDefault()
    const instruction = instructionText.trim()
    setInstructionTarget(null)
    setInstructionText('')
    // An empty instruction falls back to the default regeneration prompt
    await handleRegenerateSection(sectionTitle, instruction || undefined)
  }

  // Which corpus examples informed this script's generations, for traceability
  const informingExampleIds = conversation
    ? [...new Set(conversation.generations.flatMap(generation => generation.exampleIds ?? []))]
    : []
  const exampleTitleById = new Map(
    getAllExamples().map(example => [example.id, example.title])
  )

  const handlePromoteToExample = () => {
    if (!script || !document.fullContent) return
    promoteScriptToExample(
      document.title ?? script.title,
      document.fullContent,
      script.tags ?? []
    )
    setPromotedToExamples(true)
  }

  const handleRefineSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!conversation) return
    const instruction = refineInstruction.trim()
    if (!instruction) return

    setRefineInstruction('')
    try {
      await refineScript({ conversationId: conversation.id, instruction })
    } catch (error) {
      console.error('Error refining script:', error)
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

  // The conversation history loads asynchronously from persistent storage;
  // until it arrives there is nothing meaningful to render for this script
  if (!conversation && !conversationsLoaded) {
    return (
      <section aria-busy="true">
        <p role="status">Loading script...</p>
      </section>
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

      {persistentErrorMessage && (
        <div role="alert" className="generation-notice" data-kind="error">
          <p>
            <strong>Generation failed.</strong> {persistentErrorMessage}
          </p>
          <button
            onClick={handleRetry}
            aria-label="Retry script generation"
            type="button"
          >
            <RotateCcw size={16} />
            Retry
          </button>
        </div>
      )}

      {wasInterrupted && (
        <div role="status" className="generation-notice" data-kind="interrupted">
          <p>
            This generation was interrupted before it finished. Everything
            written so far is saved.
          </p>
          <button
            onClick={handleRetry}
            aria-label="Resume script generation"
            type="button"
          >
            <Play size={16} />
            Resume
          </button>
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
                <>
                  <header>
                    <h2>{section.title}</h2>
                    {!generationState.shouldDisableRegenerate && conversation && (
                      <div className="section-actions">
                        <button
                          onClick={() => handleStartEdit(section.title, section.content)}
                          aria-label={`Edit ${section.title} section`}
                          type="button"
                        >
                          <Pencil size={16} />
                          Edit
                        </button>
                        <button
                          onClick={() => handleRegenerateSection(section.title)}
                          disabled={generationState.shouldDisableRegenerate}
                          aria-label={`Regenerate ${section.title} section`}
                          type="button"
                        >
                          <RotateCcw size={16} />
                          Regenerate
                        </button>
                        <button
                          onClick={() => handleToggleInstructionForm(section.title)}
                          aria-expanded={instructionTarget === section.title}
                          aria-controls={`${section.id}_instruction`}
                          aria-label={`Regenerate ${section.title} section with instructions`}
                          type="button"
                        >
                          <SlidersHorizontal size={16} />
                        </button>
                      </div>
                    )}
                  </header>
                  {instructionTarget === section.title &&
                    !generationState.shouldDisableRegenerate &&
                    conversation && (
                    <form
                      className="regenerate-form"
                      id={`${section.id}_instruction`}
                      aria-label={`Regenerate ${section.title} with instructions`}
                      onSubmit={(event) => handleInstructionSubmit(event, section.title)}
                    >
                      <label className="sr-only" htmlFor={`${section.id}_instruction_input`}>
                        How should the {section.title} section change? Leave empty for a standard rewrite.
                      </label>
                      <input
                        id={`${section.id}_instruction_input`}
                        type="text"
                        value={instructionText}
                        onChange={(event) => setInstructionText(event.target.value)}
                        placeholder="e.g. less repetition, more breathing focus"
                        autoFocus
                      />
                      <button type="submit">
                        <RotateCcw size={14} />
                        Regenerate
                      </button>
                    </form>
                  )}
                </>
              )}
              {editTarget === section.title &&
                !generationState.shouldDisableRegenerate &&
                conversation ? (
                <form
                  className="section-edit-form"
                  aria-label={`Edit ${section.title} section`}
                  onSubmit={(event) => handleEditSubmit(event, section.title)}
                >
                  <label className="sr-only" htmlFor={`${section.id}_edit_input`}>
                    Text of the {section.title} section
                  </label>
                  <textarea
                    id={`${section.id}_edit_input`}
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    rows={Math.max(6, editDraft.split('\n').length + 1)}
                    autoFocus
                  />
                  <div className="section-edit-actions">
                    <button type="submit" disabled={!editDraft.trim()}>
                      <Check size={16} />
                      Save
                    </button>
                    <button type="button" onClick={handleCancelEdit}>
                      <X size={16} />
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div>
                  {section.content
                    .split('\n')
                    .map((line, lineIndex) => ({ text: line, key: `line-${lineIndex}` }))
                    .filter(({ text }) => !text.startsWith('## ') && text.trim())
                    .map(({ text, key }) => (
                      <p key={key}>{text}</p>
                    ))}
                </div>
              )}
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

      {!generationState.isGenerating &&
        (informingExampleIds.length > 0 || (script.status === 'complete' && document.fullContent)) && (
        <footer className="script-utility">
          {informingExampleIds.length > 0 ? (
            <details className="example-provenance">
              <summary>
                Grounded in {informingExampleIds.length}{' '}
                {informingExampleIds.length === 1 ? 'example' : 'examples'}
              </summary>
              <ul>
                {informingExampleIds.map(exampleId => (
                  <li key={exampleId}>{exampleTitleById.get(exampleId) ?? exampleId}</li>
                ))}
              </ul>
            </details>
          ) : (
            <span />
          )}
          {script.status === 'complete' && document.fullContent && (
            promotedToExamples ? (
              <p className="example-promoted" role="status">Saved to your example corpus</p>
            ) : (
              <button
                onClick={handlePromoteToExample}
                aria-label="Save this script as an example"
                type="button"
              >
                <BookmarkPlus size={16} />
                Save as example
              </button>
            )
          )}
        </footer>
      )}

      {conversation && document.sections.length > 0 && !generationState.isGenerating && (
        <form
          className="refine-form"
          aria-label="Refine this script"
          onSubmit={handleRefineSubmit}
        >
          <label className="sr-only" htmlFor="refine-instruction">
            Refine this script with a follow-up instruction
          </label>
          <input
            id="refine-instruction"
            type="text"
            value={refineInstruction}
            onChange={(event) => setRefineInstruction(event.target.value)}
            placeholder="Refine this script — e.g. make the induction slower"
          />
          <button
            type="submit"
            disabled={!refineInstruction.trim()}
            aria-label="Refine script"
          >
            <ArrowUp size={18} />
          </button>
        </form>
      )}

      {performanceMode && onExitPerformanceMode && document.sections.length > 0 && (
        <PerformanceMode
          title={script.status === 'complete' ? script.title : (document.title ?? script.title)}
          sections={document.sections}
          showSectionTitles={showSectionTitles}
          onExit={onExitPerformanceMode}
        />
      )}
    </section>
  )
}
