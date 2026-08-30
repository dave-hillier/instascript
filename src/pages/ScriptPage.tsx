import { useEffect, useReducer, useState } from 'react'
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
import { buildProgressRows, type ProgressPlan } from '../utils/scriptProgress'
import {
  exampleFolder,
  findExampleForScript,
  getAllExamples,
  promoteScriptToExample
} from '../services/exampleCorpus'
import { formatReviewSummary, reviewReportDescribesStructure } from '../services/critiquePass'
import { markReducer, marksToStore, NO_MARK_STATE } from '../reducers/markReducer'
import { findingKey, loadMarks, saveMarks, type ReaderFlag } from '../services/markStore'
import {
  documentMarkView,
  focusedRunKey,
  markFaultNote,
  markMadeNote,
  type SectionMark
} from '../services/sectionMarkView'
import { resolveSpan } from '../services/span'
import { projectConversation, sectionRevisions } from '../services/scriptProjection'
import { SECTION_TARGET_WORDS } from '../services/sectionQuality'
import type { ScriptDocumentSection } from './scriptPageDocument'
import type { Script } from '../types/script'


const TARGET_WORDS_PER_SECTION = SECTION_TARGET_WORDS

// Joins the observed finding keys into one dependency. A record separator
// cannot appear in a key: the keys are built from a stage, a section title, a
// reason and a quote, joined by a unit separator.
const FINDING_KEY_SEPARATOR = '\u001E'

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
  // The reader's own marks and the findings they have put away. Browser-only
  // and keyed by script id (M2): a flag is a note about the words in front of
  // the reader, not part of the record of how the script was written.
  const [markState, markDispatch] = useReducer(markReducer, NO_MARK_STATE)
  // Which mark the reader asked to be shown, so the panel and the body agree
  const [focusedMarkId, setFocusedMarkId] = useState<string | null>(null)
  // Why the last selection could not be marked, when it could not be
  const [selectionNote, setSelectionNote] = useState<string | null>(null)
  // The corpus folder this script is saved into, if it is. Read from the
  // corpus rather than remembered, so a script saved in an earlier session
  // still says so.
  const [promotedFolder, setPromotedFolder] = useState<string | null>(() => {
    const saved = id ? findExampleForScript(id) : undefined
    return saved ? exampleFolder(saved) : null
  })

  // Marks are loaded per script and saved whenever they change. The script id
  // is carried in the state itself so a save cannot be misfiled: navigating
  // between scripts changes the id and the loaded marks in the same event.
  useEffect(() => {
    if (!id) return
    markDispatch({ type: 'MARKS_LOADED', scriptId: id, marks: loadMarks(id) })
    setFocusedMarkId(null)
    setSelectionNote(null)
  }, [id])

  useEffect(() => {
    if (markState.scriptId === null) return
    saveMarks(markState.scriptId, marksToStore(markState))
  }, [markState])

  const script = state.scripts.find((s: Script) => s.id === id)
  const conversation = script ? getConversationByScriptId(script.id) : undefined
  const currentGeneration = conversationState.currentGeneration
  const generationMachine = conversationState.generationMachine
  const reviewReport = conversationState.reviewReport

  // The conversation is folded ONCE per render and everything the page needs
  // is read off that one projection — the document it draws, and the findings
  // the judging passes recorded. Folding again for the findings would redo the
  // whole conversation on every keystroke in the section editor and the refine
  // composer.
  const projected = projectConversation(conversation, currentGeneration)
  // The generating flag belongs to this conversation alone: a run started on
  // another script must not make this one read as being written.
  const document = {
    title: projected.title,
    sections: projected.sections,
    fullContent: projected.fullContent,
    isGenerating: !!conversation && !!currentGeneration &&
      currentGeneration.conversationId === conversation.id &&
      !currentGeneration.isComplete
  }
  const findings = projected.findings ?? []
  const generationState = {
    isGenerating: document.isGenerating,
    shouldDisableRegenerate: document.isGenerating,
    error: currentGeneration?.error
  }
  // Section actions, and spending a mark, are both off while a run is in
  // flight and where there is no conversation to ask through.
  const canEditSections = !generationState.shouldDisableRegenerate && !!conversation

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

  // Answers whether the rewrite actually happened, because spending a mark
  // turns on it: a mark discarded against a rewrite that failed is a reader's
  // note lost with nothing to restore it from.
  const handleRegenerateSection = async (
    sectionTitle: string,
    instruction?: string
  ): Promise<boolean> => {
    if (!script || !conversation) return false

    try {
      await regenerateSection({
        conversationId: conversation.id,
        sectionTitle: sectionTitle,
        instruction,
        targetMinutes: script.targetMinutes,
        brief: script.initialPrompt ?? script.title
      })
      return true
    } catch (error) {
      console.error('Error regenerating section:', error)
      return false
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

  // Library to corpus (story 8.16). A script already saved is updated in the
  // folder it was filed into rather than joined by a stale copy of itself.
  const handlePromoteToExample = () => {
    if (!script || !document.fullContent) return
    const example = promoteScriptToExample({
      title: document.title ?? script.title,
      content: document.fullContent,
      tags: script.tags ?? [],
      scriptId: script.id
    })
    setPromotedFolder(exampleFolder(example))
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


  // The findings the document now carries, as the store names them. Joined
  // into one string so the pruning effect below runs when that set changes
  // rather than on every keystroke.
  const observedFindingKeys = findings
    .map(finding => findingKey(finding, finding.stage))
    .join(FINDING_KEY_SEPARATOR)

  // What the reader dismissed or spent is kept honest against the document.
  // A key no finding produces any more hides nothing and can restore nothing,
  // and left alone both lists would grow for the life of the script.
  //
  // Only once the conversation store has answered: before it does, a script
  // with findings and one still loading look identical from here, and pruning
  // against the loading one would forget every dismissal the reader made.
  useEffect(() => {
    if (!conversationsLoaded || markState.scriptId !== id) return
    markDispatch({
      type: 'FINDINGS_OBSERVED',
      keys: observedFindingKeys === '' ? [] : observedFindingKeys.split(FINDING_KEY_SEPARATOR)
    })
  }, [conversationsLoaded, id, markState.scriptId, observedFindingKeys])

  // Everything about how marks are drawn and what they offer is decided in
  // services/sectionMarkView, in one pass over the whole document; this page
  // holds the reader's state and hands the answer to the components.
  const markView = documentMarkView({
    sections: document.sections,
    findings,
    flags: markState.flags,
    dismissed: markState.dismissed,
    spent: markState.spent,
    // Spending is hidden, never queued, while a generation is in flight (M4)
    canSpend: canEditSections,
    focusedMarkId
  })

  // The reader selected words in a section body. The selection is resolved
  // against that body by exactly the rule a model's quoted passage is held to,
  // so a mark that could not be found again is refused with the reason rather
  // than stored and quietly relocated later.
  const handlePassageSelected = (sectionTitle: string, selection: string): void => {
    const section = document.sections.find(candidate => candidate.title === sectionTitle)
    if (!section) return
    if (section.isLive) {
      setSelectionNote('This section is still being written. Mark it once it settles.')
      return
    }

    const resolved = resolveSpan(section.content, selection)
    if (!resolved.ok) {
      setSelectionNote(markFaultNote(resolved))
      return
    }

    // Said out loud, because nothing else about a successful mark is: the
    // panel entry and the highlight are both silent to a reader who cannot
    // see them, and this is the same region a refusal is announced in.
    setSelectionNote(markMadeNote(resolved.anchor.quote))
    setFocusedMarkId(null)
    const flag: ReaderFlag = {
      id: `flag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      section: sectionTitle,
      anchor: resolved.anchor,
      // What the body had been through when the passage was pinned, so a
      // rewrite that happened afterwards can be told from one that did not
      revisions: sectionRevisions(section),
      label: 'Marked passage',
      createdAt: Date.now()
    }
    markDispatch({ type: 'PASSAGE_FLAGGED', flag })
  }

  // Spending a mark is an ordinary section rewrite down the path that already
  // exists — the instruction is the passage and the reason, nothing new.
  //
  // The mark is given up only once the rewrite has actually happened. A
  // provider error would otherwise take the reader's own note with it, and a
  // flag is not recoverable from anywhere: it was never in the conversation.
  // Nothing can be spent twice in the meantime, because a mark stops being
  // spendable while the run is in flight (M4).
  const handleSpendMark = async (mark: SectionMark): Promise<void> => {
    if (!mark.spendable) return
    setFocusedMarkId(null)
    const rewritten = await handleRegenerateSection(mark.section, mark.instruction)
    if (!rewritten) return
    markDispatch(
      mark.kind === 'flag'
        ? { type: 'FLAG_SPENT', id: mark.key }
        : { type: 'FINDING_SPENT', key: mark.key }
    )
  }

  // Dismissing changes nothing in the conversation. A finding is remembered as
  // hidden, because the model did make it and the log has to keep saying so; a
  // flag was only ever the reader's own note, so it goes.
  const handleDismissMark = (mark: SectionMark): void => {
    markDispatch(
      mark.kind === 'flag'
        ? { type: 'FLAG_DISMISSED', id: mark.key }
        : { type: 'FINDING_DISMISSED', key: mark.key }
    )
    if (focusedMarkId === mark.id) setFocusedMarkId(null)
  }

  const handleRestoreDismissed = (): void => {
    for (const key of markState.dismissed) {
      markDispatch({ type: 'FINDING_RESTORED', key })
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
        markViews={markView.bySection}
        marks={markView.marks}
        focusedMarkId={focusedMarkId}
        focusedRunKey={focusedRunKey(markView.marks, focusedMarkId)}
        onFocusMark={setFocusedMarkId}
        onPassageSelected={handlePassageSelected}
        selectionNote={selectionNote}
        onSpendMark={handleSpendMark}
        onDismissMark={handleDismissMark}
        onRelabelMark={(mark, label) => markDispatch({ type: 'FLAG_RELABELLED', id: mark.key, label })}
        onAnnotateMark={(mark, note) => markDispatch({ type: 'FLAG_ANNOTATED', id: mark.key, note })}
        dismissedCount={markState.dismissed.length}
        onRestoreDismissed={handleRestoreDismissed}
        informingExamples={informingExamples}
        showScriptActions={script.status === 'complete' && !!document.fullContent}
        onReviewScript={handleReviewScript}
        onPromoteToExample={handlePromoteToExample}
        promotedFolder={promotedFolder}
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
