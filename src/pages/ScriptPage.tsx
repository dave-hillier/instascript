import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAppContext } from '../hooks/useAppContext'
import { useConversationContext } from '../hooks/useConversationContext'
import { TokenUsageBar } from '../components/TokenUsageBar'
import { ScriptCostSummary } from '../components/ScriptCostSummary'
import { getModel } from '../services/config'
import { PerformanceMode } from '../components/PerformanceMode'
import { ConversationPanel } from '../components/ConversationPanel'
import { ScriptDocument } from '../components/ScriptDocument'
import { buildThread } from '../services/conversationThread'
import { extractDocumentTitle } from '../utils/scriptMetrics'
import { buildProgressRows, type ProgressPlan } from '../utils/scriptProgress'
import { getAllExamples, promoteScriptToExample } from '../services/exampleCorpus'
import { formatReviewSummary, reviewReportDescribesStructure } from '../services/critiquePass'
import { SECTION_TARGET_WORDS } from '../services/sectionQuality'
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

const TARGET_WORDS_PER_SECTION = SECTION_TARGET_WORDS

interface WordCountMeterProps {
  sections: ScriptDocumentSection[]
  generationMachine: ProgressPlan | null
}

const WordCountMeter = ({ sections, generationMachine }: WordCountMeterProps) => {
  const totalWords = sections.reduce((sum, s) => sum + s.wordCount, 0)

  // Written sections plus whatever the outline still plans, so sections added,
  // renamed or split since the outline was drawn appear as soon as they exist
  const rows = buildProgressRows(sections, generationMachine)

  if (rows.length === 0 && !generationMachine) return null

  return (
    <aside aria-label="Word count breakdown">
      <div className="word-meter">
        <div className="word-meter-header">
          <span>Word count</span>
          <span>{totalWords} total</span>
        </div>
        <div className="word-meter-bars">
          {rows.map((row, i) => {
            const label = row.title || `Section ${i + 1}`
            const fillPercent = Math.min(100, (row.wordCount / TARGET_WORDS_PER_SECTION) * 100)

            return (
              <div key={row.title || i} className="word-meter-row" data-state={row.state}>
                <span className="word-meter-label">{label}</span>
                <div className="word-meter-track">
                  <div
                    className="word-meter-fill"
                    style={{ width: `${fillPercent}%` }}
                    role="progressbar"
                    aria-valuenow={row.wordCount}
                    aria-valuemin={0}
                    aria-valuemax={TARGET_WORDS_PER_SECTION}
                    aria-label={`${label}: ${row.wordCount} words`}
                  />
                  <span className="word-meter-target" />
                </div>
                <span className="word-meter-count">{row.wordCount}</span>
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
    dispatch: conversationDispatch,
    getConversationByScriptId,
    createConversation,
    generateScript,
    regenerateSection,
    refineScript,
    reviewScript,
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
  // The instruction that is being applied right now, shown as a thread turn
  // while it runs; it returns to the composer if the refinement fails
  const [pendingInstruction, setPendingInstruction] = useState<string | null>(null)
  // Why the last refinement failed, shown alongside the preserved instruction
  const [refineError, setRefineError] = useState<string | null>(null)
  // Why the last on-demand style review failed, shown beside its button
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [promotedToExamples, setPromotedToExamples] = useState(false)

  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  const generationMachine = conversationState.generationMachine
  const reviewReport = conversationState.reviewReport

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
      : isThisConversation && generationMachine.phase === 'reviewing'
        ? 'Reviewing the script...'
        : currentGeneration && !currentGeneration.isComplete
          ? currentGeneration.sectionTitle
            ? `Rewriting "${currentGeneration.sectionTitle}"...`
            : 'Refining script...'
          : 'Generating...'


  // A failed generation stays visible after the generating flag clears. A
  // failed refinement reports next to the refine form instead (story 1.7),
  // so it is excluded here to avoid a duplicate banner.
  const persistentErrorMessage = !generationState.isGenerating && conversation && !refineError
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

  // Retry resumes from the persisted outline and completed sections when
  // possible (story 1.8); fresh restarts the generation from scratch
  const handleRetry = async (fresh = false) => {
    if (!script) return

    const prompt = script.initialPrompt ?? script.title
    const conversationId = conversation?.id ?? createConversation(script.id).id

    try {
      await generateScript({ prompt, conversationId, fresh, targetMinutes: script.targetMinutes })
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
        instruction,
        targetMinutes: script.targetMinutes,
        brief: script.initialPrompt ?? script.title
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
  const informingExamples = informingExampleIds.map(exampleId => ({
    id: exampleId,
    title: exampleTitleById.get(exampleId) ?? exampleId
  }))

  const handlePromoteToExample = () => {
    if (!script || !document.fullContent) return
    promoteScriptToExample(
      document.title ?? script.title,
      document.fullContent,
      script.tags ?? []
    )
    setPromotedToExamples(true)
  }

  // An on-demand cohesion and length review of the finished script (story
  // 8.14); its outcome arrives as the review report banner
  const handleReviewScript = async () => {
    if (!conversation || !script) return

    setReviewError(null)
    try {
      await reviewScript(conversation.id, script.initialPrompt ?? script.title, script.targetMinutes)
    } catch (error) {
      console.error('Error reviewing script:', error)
      setReviewError(error instanceof Error ? error.message : 'Unknown error')
    }
  }

  // The instruction clears only once the refinement succeeds (story 1.7):
  // on failure it stays in the input, with the failure reason alongside
  const handleRefineSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!conversation || !script) return
    const instruction = refineInstruction.trim()
    if (!instruction) return

    setRefineError(null)
    setRefineInstruction('')
    setPendingInstruction(instruction)
    try {
      await refineScript({
        conversationId: conversation.id,
        instruction,
        targetMinutes: script.targetMinutes,
        brief: script.initialPrompt ?? script.title
      })
    } catch (error) {
      console.error('Error refining script:', error)
      setRefineInstruction(instruction)
      setRefineError(error instanceof Error ? error.message : 'Unknown error')
    } finally {
      setPendingInstruction(null)
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

  // The opening turn carries the brief plus the facts that shaped the request
  const briefChips = [
    script.targetMinutes ? `${script.targetMinutes} min` : script.length,
    ...(script.tags ?? [])
  ].filter((chip): chip is string => Boolean(chip))

  const threadEntries = buildThread({
    brief: script.initialPrompt ?? script.title,
    chips: briefChips,
    conversation,
    isStreaming: generationState.isGenerating
  })

  // The summary names sections and states a length, so it survives only while
  // the script still has the structure it was written against
  const reviewSummary = reviewReport && conversation &&
    reviewReport.conversationId === conversation.id &&
    reviewReportDescribesStructure(reviewReport, document.sections.map(section => section.title))
    ? reviewReport.summary ?? formatReviewSummary(reviewReport.revised)
    : undefined

  const canEditSections = !generationState.shouldDisableRegenerate && !!conversation

  return (
    <div className="workspace">
      <ConversationPanel
        entries={threadEntries}
        pendingInstruction={pendingInstruction}
        isGenerating={generationState.isGenerating}
        phaseLabel={phaseLabel}
        onStop={stopGeneration}
        errorMessage={persistentErrorMessage}
        wasInterrupted={wasInterrupted}
        onRetry={() => handleRetry()}
        onStartOver={() => handleRetry(true)}
        reviewSummary={reviewSummary}
        onDismissReview={() => conversationDispatch({ type: 'REVIEW_REPORT_DISMISSED' })}
        instruction={refineInstruction}
        onInstructionChange={setRefineInstruction}
        onSubmit={handleRefineSubmit}
        refineError={refineError}
        canRefine={!!conversation && document.sections.length > 0}
      >
        <details className="run-details">
          <summary>Progress and usage</summary>
          <WordCountMeter
            sections={document.sections}
            generationMachine={isThisConversation ? generationMachine : null}
          />
          <TokenUsageBar conversation={conversation} />
          <ScriptCostSummary
            conversation={conversation}
            model={script.model ?? getModel()}
          />
        </details>
      </ConversationPanel>

      <ScriptDocument
        sections={document.sections}
        fullContent={document.fullContent}
        showSectionTitles={showSectionTitles}
        canEditSections={canEditSections}
        isGenerating={generationState.isGenerating}
        instructionTarget={instructionTarget}
        instructionText={instructionText}
        onInstructionTextChange={setInstructionText}
        onToggleInstructionForm={handleToggleInstructionForm}
        onInstructionSubmit={handleInstructionSubmit}
        onRegenerateSection={handleRegenerateSection}
        editTarget={editTarget}
        editDraft={editDraft}
        onEditDraftChange={setEditDraft}
        onStartEdit={handleStartEdit}
        onCancelEdit={handleCancelEdit}
        onEditSubmit={handleEditSubmit}
        informingExamples={informingExamples}
        showScriptActions={script.status === 'complete' && !!document.fullContent}
        onReviewScript={handleReviewScript}
        onPromoteToExample={handlePromoteToExample}
        promotedToExamples={promotedToExamples}
        reviewError={reviewError}
      />

      {performanceMode && onExitPerformanceMode && document.sections.length > 0 && (
        <PerformanceMode
          title={script.status === 'complete' ? script.title : (document.title ?? script.title)}
          sections={document.sections}
          showSectionTitles={showSectionTitles}
          onExit={onExitPerformanceMode}
        />
      )}
    </div>
  )
}
