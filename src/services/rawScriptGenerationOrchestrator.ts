import type { RawConversation, GenerationRequest, RegenerationRequest, RefinementRequest, ChatMessage, ReviewRevision, ScriptOutline } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversationAction } from '../reducers/rawConversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt, getOutlineGenerationPrompt, getSectionGenerationPrompt, buildStyleCritiquePrompt, buildOutlineCritiquePrompt, buildScriptReviewPrompt, buildSectionRegenerationPromptFromConversation, buildConversationHistory, buildGenerationSystemPrompt, withGenerationSystemPrompt, withStructureBlock } from './prompts'
import { buildScriptFs } from './scriptFs'
import { getRecommendedExampleCount, estimateSectionContextTokens } from '../utils/contextWindow'
import { countWords, formatScriptLength } from '../utils/scriptMetrics'
import { parseOutline, ensureSectionHeading, consolidateSections, getLatestOutline, parseMarkdownSections } from './conversationDocument'
import { shouldRetrySection, pickBetterSectionText, buildRetryNote } from './sectionQuality'
import { parseCritiqueResponse, selectViolationsToRevise, buildRevisionInstruction, STYLE_REVIEW_SECTION_TITLE } from './critiquePass'
import { parseOutlineCritiqueResponse, OUTLINE_CRITIQUE_SECTION_TITLE } from './outlineCritique'
import { buildLengthPlan } from './scriptLength'
import type { LengthPlan } from './scriptLength'
import { assessScriptLength, formatLengthBrief, parseScriptReviewResponse, selectScriptRevisions, buildScriptRevisionInstruction, describeRevisionReason, formatScriptReviewSummary, SCRIPT_REVIEW_SECTION_TITLE } from './scriptReview'
import { KeyedRunGuard } from './runLifecycle'
import { recordExampleSelections } from './exampleCorpus'

export interface RawScriptServices {
  scriptService: {
    generateScript(
      request: GenerationRequest,
      messages?: ChatMessage[],
      examples?: ExampleScript[],
      abortSignal?: AbortSignal
    ): AsyncIterable<string>
    regenerateSection(
      request: RegenerationRequest,
      messages: ChatMessage[],
      abortSignal?: AbortSignal
    ): AsyncIterable<string>
    getLastRequestMessages?(): ChatMessage[]
  }
  exampleService: {
    searchExamples(prompt: string, count: number): Promise<ExampleScript[]>
  }
}

export interface RawGenerationCallbacks {
  dispatch: (action: RawConversationAction) => void
  appDispatch: (action: { type: 'UPDATE_SCRIPT'; scriptId: string; updates: Partial<Script> }) => void
  saveConversation: (conversation: RawConversation) => void
  getConversation: (conversationId: string) => RawConversation | undefined
}

export interface RawGenerationOptions {
  // When true, a full generation ends with a style-review pass (story 8.5)
  reviewPassEnabled?: boolean
}

interface ReviewPassResult {
  // True when the critique request completed, so the outcome can be reported
  ran: boolean
  revised: ReviewRevision[]
  // The consolidated script including revised sections, when any were revised
  updatedContent?: string
}

interface ResumeState {
  outline: ScriptOutline
  outlineText: string
  sectionTexts: Map<string, string>
}

// Inspect an existing conversation for a usable outline and already-generated
// sections, so an interrupted or failed run can pick up where it left off
// instead of starting over. Exported for unit testing.
export function findResumeState(conversation: RawConversation): ResumeState | null {
  let outline: ScriptOutline | null = null
  let outlineText = ''
  let outlineIndex = -1

  for (let i = 0; i < conversation.generations.length; i++) {
    const parsed = parseOutline(conversation.generations[i].response)
    if (parsed) {
      outline = parsed
      outlineText = conversation.generations[i].response
      outlineIndex = i
    }
  }

  if (!outline) return null

  // An outline that is the conversation's last generation may itself be
  // truncated (interrupted mid-stream) even though it parses — a shortened
  // plan would silently produce a shorter script. Only trust an outline the
  // run demonstrably moved past: section generation starts a new entry, so a
  // later generation proves the outline finished streaming.
  if (outlineIndex === conversation.generations.length - 1) return null

  const sectionTexts = new Map<string, string>()
  for (let i = outlineIndex + 1; i < conversation.generations.length; i++) {
    const match = conversation.generations[i].response.match(/^##\s+(.+?)\s*\n([\s\S]*)$/)
    if (match && match[2].trim()) {
      sectionTexts.set(match[1].trim(), match[2].trim())
    }
  }

  return { outline, outlineText, sectionTexts }
}

export class RawScriptGenerationOrchestrator {
  private services: RawScriptServices
  private callbacks: RawGenerationCallbacks
  private options: RawGenerationOptions
  private activeGenerations = new KeyedRunGuard()
  private completedGenerations = new Set<string>()
  private lastSaveTime = 0
  private saveThrottleMs = 1000
  // The corpus a conversation's run was grounded in, so a rewrite triggered
  // later in the same session sees the same exemplars without retrieving again
  private runExamples = new Map<string, ExampleScript[]>()

  constructor(
    services: RawScriptServices,
    callbacks: RawGenerationCallbacks,
    options: RawGenerationOptions = {}
  ) {
    this.services = services
    this.callbacks = callbacks
    this.options = options
  }

  // A generation run builds each request from scratch, so its largest request
  // is one section's worth of outline and script-so-far, reserved below. A
  // rewrite instead replays the stored conversation, where the request
  // messages dwarf the responses and the outline and script are already
  // counted — so the two paths size the corpus differently.
  private async retrieveExamples(
    request: GenerationRequest,
    conversation: RawConversation | undefined,
    plan: LengthPlan,
    replaysHistory = false
  ): Promise<ExampleScript[]> {
    try {
      const systemPrompt = getSystemPrompt(plan)
      const conversationTokens = conversation
        ? conversation.generations.reduce(
            (total: number, generation) =>
              total +
              generation.response.length +
              (replaysHistory
                ? generation.messages.reduce((sum, message) => sum + message.content.length, 0)
                : 0),
            0
          )
        : 0
      const optimalExampleCount = getRecommendedExampleCount(
        systemPrompt,
        Math.ceil(conversationTokens / 4),
        replaysHistory ? 0 : estimateSectionContextTokens(plan.totalWords, plan.sectionCount)
      )

      return await this.services.exampleService.searchExamples(
        request.prompt,
        optimalExampleCount
      )
    } catch (error) {
      console.warn('Failed to retrieve examples', error)
      return []
    }
  }

  // The run's exemplars for a rewrite that did not start from generateScript
  // (a manual regeneration or refinement after a reload), retrieved once per
  // conversation. retrieveExamples swallows failures, so this degrades to an
  // ungrounded rewrite rather than failing the request.
  private async examplesFor(
    conversationId: string,
    query: string,
    plan: LengthPlan,
    conversation?: RawConversation
  ): Promise<ExampleScript[]> {
    const cached = this.runExamples.get(conversationId)
    if (cached) return cached

    const examples = await this.retrieveExamples({ prompt: query }, conversation, plan, true)
    this.runExamples.set(conversationId, examples)
    return examples
  }

  private persistConversation(conversationId: string): void {
    const conversation = this.callbacks.getConversation(conversationId)
    if (conversation) {
      this.callbacks.saveConversation(conversation)
    }
  }

  private async streamToString(
    stream: AsyncIterable<string>,
    conversationId: string,
    abortSignal?: AbortSignal,
    onChunk?: (accumulated: string) => void
  ): Promise<string> {
    let accumulated = ''

    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        throw new Error('Generation aborted')
      }

      accumulated += chunk

      if (onChunk) {
        onChunk(accumulated)
      }

      // Throttled save during streaming
      const now = Date.now()
      if (now - this.lastSaveTime > this.saveThrottleMs) {
        this.persistConversation(conversationId)
        this.lastSaveTime = now
      }
    }

    return accumulated
  }

  async generateScript(
    request: GenerationRequest,
    conversation?: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!conversation) {
      throw new Error('Conversation is required for generation')
    }

    const conversationId = conversation.id
    const generationKey = `${conversationId}-initial`
    // The requested length shapes the system prompt, the outline's section
    // count and the length the finished script is judged against
    const plan = buildLengthPlan(request.targetMinutes)

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh run (first attempt, retry or resume) owns generation state from here
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })
      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: { status: 'in-progress' }
      })

      // Retrieve examples upfront; record which ones inform this generation
      const examples = await this.retrieveExamples(request, conversation, plan)
      this.runExamples.set(conversationId, examples)
      const systemPrompt = buildGenerationSystemPrompt(plan, examples)
      const exampleIds = examples
        .map(example => String(example.metadata?.id ?? example.metadata?.filename ?? ''))
        .filter(Boolean)

      // Aggregate traceability (story 8.11): one selection per generation run
      // for each example that informs it
      recordExampleSelections(exampleIds)

      if (abortSignal?.aborted) throw new Error('Generation aborted')

      // An explicit fresh restart (story 1.8) discards the previous outline
      // and sections so nothing from the abandoned plan survives consolidation
      if (request.fresh && conversation.generations.length > 0) {
        this.callbacks.dispatch({ type: 'GENERATIONS_DISCARDED', conversationId })
        this.callbacks.saveConversation({
          ...conversation,
          generations: [],
          updatedAt: Date.now()
        })
      }

      // Reuse an existing outline and completed sections when retrying/resuming
      const resume = request.fresh ? null : findResumeState(conversation)
      let outline: ScriptOutline
      let outlineText: string

      if (resume) {
        outline = resume.outline
        outlineText = resume.outlineText
      } else {
        // --- Phase 1: Generate outline ---
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'generating_outline',
          currentSectionIndex: 0,
          totalSections: 0,
          sectionWordCounts: []
        })

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: false
        })

        const outlineUserPrompt = request.prompt + '\n\n' + getOutlineGenerationPrompt(plan)
        const outlineMessages: ChatMessage[] = [
          { role: 'system', content: getSystemPrompt(plan) },
          { role: 'user', content: outlineUserPrompt }
        ]

        // Start a generation entry for the outline
        this.callbacks.dispatch({
          type: 'START_GENERATION',
          conversationId,
          messages: outlineMessages,
          exampleIds: exampleIds.length > 0 ? exampleIds : undefined
        })

        const outlineStream = this.services.scriptService.generateScript(
          { ...request, prompt: outlineUserPrompt },
          withGenerationSystemPrompt(outlineMessages, systemPrompt),
          examples,
          abortSignal
        )

        outlineText = await this.streamToString(
          outlineStream,
          conversationId,
          abortSignal,
          (accumulated) => {
            this.callbacks.dispatch({
              type: 'UPDATE_CURRENT_GENERATION',
              conversationId,
              response: accumulated
            })
          }
        )

        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
          conversationId,
          response: outlineText
        })

        this.persistConversation(conversationId)

        // Parse the outline
        const parsedOutline = parseOutline(outlineText)
        if (!parsedOutline) {
          throw new Error('Failed to parse outline from LLM response')
        }
        outline = parsedOutline

        // --- Phase 1.5: optional outline critique (story 8.9) ---
        // Checked against the brief before any section is written; a revised
        // outline supersedes the original as the plan every section inherits.
        // Gated by the same setting as the style-review pass.
        if (this.options.reviewPassEnabled) {
          const critiqued = await this.runOutlineCritique(
            conversationId,
            request,
            plan,
            outline,
            outlineText,
            abortSignal
          )
          outline = critiqued.outline
          outlineText = critiqued.outlineText
        }
      }

      if (abortSignal?.aborted) throw new Error('Generation aborted')

      // --- Phase 2: Generate sections one at a time ---
      const sectionWordCounts: number[] = []
      let scriptContent = `# ${outline.title}`
      let startIndex = 0

      if (resume) {
        // Keep fully generated sections; redo the last present one since it may
        // have been cut off mid-stream, then continue with the missing ones
        let firstMissing = outline.sections.findIndex(
          section => !resume.sectionTexts.has(section.title)
        )
        if (firstMissing === -1) firstMissing = outline.sections.length
        startIndex = Math.max(0, firstMissing - 1)

        for (let i = 0; i < startIndex; i++) {
          const section = outline.sections[i]
          const text = resume.sectionTexts.get(section.title) ?? ''
          sectionWordCounts.push(countWords(text))
          scriptContent += `\n\n## ${section.title}\n${text}`
        }
      }

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'generating_section',
        outline,
        currentSectionIndex: startIndex,
        totalSections: outline.sections.length,
        sectionWordCounts: [...sectionWordCounts]
      })

      for (let i = startIndex; i < outline.sections.length; i++) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        const section = outline.sections[i]

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'generating_section',
          outline,
          currentSectionIndex: i,
          totalSections: outline.sections.length,
          sectionWordCounts: [...sectionWordCounts]
        })

        // Upcoming outline entries let this section plant setups (story 8.10)
        const sectionPrompt = getSectionGenerationPrompt(
          section.title,
          section.description,
          outline.sections.slice(i + 1)
        )
        const sectionUserMessage = `Here is the outline for the full script:\n\n${outlineText}\n\nHere is what has been written so far:\n\n${scriptContent}\n\n${sectionPrompt}`

        const runSectionAttempt = async (userMessage: string): Promise<string> => {
          const sectionMessages: ChatMessage[] = [
            { role: 'system', content: getSystemPrompt(plan) },
            { role: 'user', content: request.prompt },
            { role: 'assistant', content: outlineText },
            { role: 'user', content: userMessage }
          ]

          this.callbacks.dispatch({
            type: 'START_GENERATION',
            conversationId,
            messages: sectionMessages
          })

          this.callbacks.dispatch({
            type: 'SET_GENERATION_PROGRESS',
            conversationId,
            isComplete: false,
            sectionTitle: section.title
          })

          const sectionStream = this.services.scriptService.regenerateSection(
            { prompt: userMessage, conversationId, sectionTitle: section.title },
            withGenerationSystemPrompt(sectionMessages, systemPrompt),
            abortSignal
          )

          const text = await this.streamToString(
            sectionStream,
            conversationId,
            abortSignal,
            (accumulated) => {
              this.callbacks.dispatch({
                type: 'UPDATE_CURRENT_GENERATION',
                conversationId,
                response: ensureSectionHeading(section.title, accumulated)
              })
            }
          )

          this.callbacks.dispatch({
            type: 'COMPLETE_GENERATION',
            conversationId,
            response: ensureSectionHeading(section.title, text)
          })

          return text
        }

        let sectionText = await runSectionAttempt(sectionUserMessage)
        let wordCount = countWords(sectionText)

        // A section well outside the word target gets one corrective retry;
        // the attempt closer to the target is kept
        if (shouldRetrySection(wordCount)) {
          this.persistConversation(conversationId)

          const retryText = await runSectionAttempt(
            `${sectionUserMessage}\n\n${buildRetryNote(wordCount)}`
          )

          sectionText = pickBetterSectionText(sectionText, retryText)
          wordCount = countWords(sectionText)

          if (sectionText !== retryText) {
            // The first attempt won: overwrite the retry generation's stored
            // response so consolidation-by-title lands on the kept text
            this.callbacks.dispatch({
              type: 'COMPLETE_GENERATION',
              conversationId,
              response: ensureSectionHeading(section.title, sectionText)
            })
          }
        }

        sectionWordCounts.push(wordCount)

        scriptContent += '\n\n' + ensureSectionHeading(section.title, sectionText)

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'generating_section',
          outline,
          currentSectionIndex: i + 1,
          totalSections: outline.sections.length,
          sectionWordCounts: [...sectionWordCounts]
        })

        this.persistConversation(conversationId)
      }

      // --- Phase 2.5: optional style-review pass (story 8.5) ---
      let reviewResult: ReviewPassResult | null = null
      if (this.options.reviewPassEnabled) {
        reviewResult = await this.runReviewPass(
          conversation,
          outline,
          scriptContent,
          request.targetMinutes,
          abortSignal
        )
        if (reviewResult.updatedContent) {
          scriptContent = reviewResult.updatedContent
        }
      }

      // --- Phase 3: Complete ---
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'complete',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length,
        sectionWordCounts
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      // Revised sections change the totals, so count from the final content
      const totalWords = scriptContent
        .split('\n')
        .filter(line => !/^#{1,2}\s/.test(line))
        .reduce((sum, line) => sum + countWords(line), 0)
      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: {
          status: 'complete',
          title: outline.title,
          content: scriptContent,
          length: formatScriptLength(totalWords)
        }
      })

      if (reviewResult?.ran) {
        this.callbacks.dispatch({
          type: 'REVIEW_PASS_COMPLETED',
          report: {
            conversationId,
            revised: reviewResult.revised,
            // The sections as reviewed, so the summary retires itself once the
            // script is restructured under it
            structure: parseMarkdownSections(scriptContent).map(section => section.title)
          }
        })
      }

      this.persistConversation(conversationId)

    } catch (error) {
      // The user stopped the generation: keep what streamed in and settle as a draft
      if (abortSignal?.aborted) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PHASE',
          conversationId,
          phase: 'idle'
        })

        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true
        })

        this.callbacks.appDispatch({
          type: 'UPDATE_SCRIPT',
          scriptId: conversation.scriptId,
          updates: { status: 'draft' }
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Script generation error:', error)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: { status: 'draft' }
      })

      this.persistConversation(conversationId)

      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
    }
  }

  // Outline-critique step (story 8.9): one request checks the freshly
  // generated outline against the user's brief — coverage, escalation arc,
  // section balance — and either approves it or returns a full revised
  // outline. The exchange is stored as its own generation; a revised outline
  // is the latest parseable outline in the conversation, so it supersedes
  // generation 0 for section writing, resume and regeneration alike. A
  // failed critique never fails the run: the original outline is kept.
  private async runOutlineCritique(
    conversationId: string,
    request: GenerationRequest,
    plan: LengthPlan,
    outline: ScriptOutline,
    outlineText: string,
    abortSignal?: AbortSignal
  ): Promise<{ outline: ScriptOutline; outlineText: string }> {
    try {
      const critiquePrompt = buildOutlineCritiquePrompt(request.prompt, outlineText, plan)
      const critiqueMessages: ChatMessage[] = [{ role: 'user', content: critiquePrompt }]

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: critiqueMessages
      })

      const critiqueStream = this.services.scriptService.regenerateSection(
        { prompt: critiquePrompt, conversationId, sectionTitle: OUTLINE_CRITIQUE_SECTION_TITLE },
        critiqueMessages,
        abortSignal
      )

      const critiqueText = await this.streamToString(
        critiqueStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      const result = parseOutlineCritiqueResponse(critiqueText)

      // A revision is stored as exactly the outline text, so latest-outline-
      // wins consumers (resume, regeneration) see it supersede generation 0
      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: result.revisedOutlineText ?? critiqueText
      })

      this.persistConversation(conversationId)

      if (result.revisedOutline && result.revisedOutlineText) {
        return { outline: result.revisedOutline, outlineText: result.revisedOutlineText }
      }
      return { outline, outlineText }
    } catch (error) {
      // A user abort must still end the whole run
      if (abortSignal?.aborted) throw error

      console.warn('Outline critique failed; keeping the generated outline as-is', error)
      return { outline, outlineText }
    }
  }

  // Style-review pass (story 8.5): one critique request checks the finished
  // script against the style rules, then up to MAX_REVIEW_REVISIONS violating
  // sections are regenerated once each through the ordinary
  // section-regeneration path with the violation as the instruction. A
  // failed or stopped review never fails the completed generation.
  private async runReviewPass(
    conversation: RawConversation,
    outline: ScriptOutline,
    scriptContent: string,
    targetMinutes?: number,
    abortSignal?: AbortSignal
  ): Promise<ReviewPassResult> {
    const conversationId = conversation.id
    const revised: ReviewRevision[] = []

    try {
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'reviewing',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length
      })

      // Clear the last section's title from progress so the streaming
      // critique text is not mistaken for live section content
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      const critiquePrompt = buildStyleCritiquePrompt(scriptContent)
      const critiqueMessages: ChatMessage[] = [{ role: 'user', content: critiquePrompt }]

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: critiqueMessages
      })

      const critiqueStream = this.services.scriptService.regenerateSection(
        { prompt: critiquePrompt, conversationId, sectionTitle: STYLE_REVIEW_SECTION_TITLE },
        critiqueMessages,
        abortSignal
      )

      const critiqueText = await this.streamToString(
        critiqueStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: critiqueText
      })

      this.persistConversation(conversationId)

      const verdicts = parseCritiqueResponse(critiqueText)
      const violations = selectViolationsToRevise(
        verdicts,
        outline.sections.map(section => section.title)
      )

      for (const violation of violations) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        const current = this.callbacks.getConversation(conversationId) ?? conversation
        const prompt = buildSectionRegenerationPromptFromConversation(
          current,
          violation.sectionTitle,
          buildRevisionInstruction(violation)
        )

        await this.regenerateSection(
          { prompt, conversationId, sectionTitle: violation.sectionTitle, targetMinutes },
          current,
          abortSignal
        )

        revised.push({
          sectionTitle: violation.sectionTitle,
          ruleNumbers: violation.ruleNumbers
        })
      }

      const updated = this.callbacks.getConversation(conversationId)
      const updatedContent = updated && revised.length > 0
        ? `# ${outline.title}` +
          consolidateSections(updated)
            .map(section => `\n\n## ${section.title}\n${section.content}`)
            .join('')
        : undefined

      return { ran: true, revised, updatedContent }
    } catch (error) {
      if (!abortSignal?.aborted) {
        console.warn('Style review pass failed; keeping the generated script as-is', error)
      }
      return { ran: false, revised }
    }
  }

  // On-demand whole-script review (story 8.14): judges the finished script as
  // one artifact — continuity and escalation across sections, setups paid off,
  // and the measured length against its spoken-duration target — then rewrites
  // the sections that need it through the ordinary section-regeneration path.
  // The script's current consolidated state is what gets reviewed, so a review
  // can follow manual edits, regenerations and refinements.
  async reviewScript(
    conversation: RawConversation,
    brief: string,
    targetMinutes?: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const generationKey = `${conversationId}-review`
    const plan = buildLengthPlan(targetMinutes)

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh run owns generation state from here, and clears any previous
      // review report so the banner describes this pass
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      const outline = getLatestOutline(conversation)
      if (!outline) {
        throw new Error('This script has no outline to review against')
      }

      const sections = consolidateSections(conversation)
      if (sections.length === 0) {
        throw new Error('This script has no sections to review')
      }

      const scriptContent = `# ${outline.title}` +
        sections.map(section => `\n\n## ${section.title}\n${section.content}`).join('')
      const assessment = assessScriptLength(sections, plan)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'reviewing',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      const reviewPrompt = buildScriptReviewPrompt(
        brief,
        formatLengthBrief(assessment),
        scriptContent
      )
      const reviewMessages: ChatMessage[] = [{ role: 'user', content: reviewPrompt }]

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages: reviewMessages
      })

      const reviewStream = this.services.scriptService.regenerateSection(
        { prompt: reviewPrompt, conversationId, sectionTitle: SCRIPT_REVIEW_SECTION_TITLE },
        reviewMessages,
        abortSignal
      )

      const reviewText = await this.streamToString(
        reviewStream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: reviewText
      })

      this.persistConversation(conversationId)

      const revisions = selectScriptRevisions(
        parseScriptReviewResponse(reviewText),
        sections,
        assessment
      )

      const revised: ReviewRevision[] = []
      for (const revision of revisions) {
        if (abortSignal?.aborted) throw new Error('Generation aborted')

        const current = this.callbacks.getConversation(conversationId) ?? conversation
        const prompt = buildSectionRegenerationPromptFromConversation(
          current,
          revision.sectionTitle,
          buildScriptRevisionInstruction(revision, plan)
        )

        await this.regenerateSection(
          { prompt, conversationId, sectionTitle: revision.sectionTitle, targetMinutes },
          current,
          abortSignal
        )

        revised.push({
          sectionTitle: revision.sectionTitle,
          reason: describeRevisionReason(revision)
        })
      }

      const finalSections = revised.length > 0
        ? consolidateSections(this.callbacks.getConversation(conversationId) ?? conversation)
        : sections
      const finalContent = `# ${outline.title}` +
        finalSections.map(section => `\n\n## ${section.title}\n${section.content}`).join('')
      // Reported against the script as it now stands, so the summary states
      // the length the user actually has
      const finalAssessment = assessScriptLength(finalSections, plan)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'complete',
        outline,
        currentSectionIndex: outline.sections.length,
        totalSections: outline.sections.length,
        sectionWordCounts: finalAssessment.sections.map(section => section.wordCount)
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.callbacks.appDispatch({
        type: 'UPDATE_SCRIPT',
        scriptId: conversation.scriptId,
        updates: {
          status: 'complete',
          title: outline.title,
          content: finalContent,
          length: formatScriptLength(finalAssessment.totalWords)
        }
      })

      this.callbacks.dispatch({
        type: 'REVIEW_PASS_COMPLETED',
        report: {
          conversationId,
          revised,
          summary: formatScriptReviewSummary(revised, finalAssessment),
          structure: finalSections.map(section => section.title)
        }
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // Whether stopped or failed, the script itself is untouched apart from
      // any sections already revised, so settle without an error phase: a
      // failed review is reported next to its own button, not as a failed
      // generation
      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.persistConversation(conversationId)

      if (abortSignal?.aborted) return

      console.error('Style review error:', error)
      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
    }
  }

  async regenerateSection(
    request: RegenerationRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const generationKey = `${conversationId}-${request.sectionTitle}`

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh regeneration run owns generation state from here; without this
      // a previously completed run's state would swallow the progress updates
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false,
        sectionTitle: request.sectionTitle
      })

      // Build complete conversation history from all generations, normalised
      // to a single system message (story 8.13)
      const messages = buildConversationHistory(conversation, request.prompt)

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages
      })

      this.persistConversation(conversationId)

      const plan = buildLengthPlan(request.targetMinutes)
      const examples = await this.examplesFor(
        conversationId,
        request.brief?.trim() || request.prompt,
        plan,
        conversation
      )

      // The rewrite sees where this section sits in the whole script, and the
      // same exemplars the system prompt carries, mounted under /examples/ so
      // both blocks name them the same way. Added at send time only, after
      // START_GENERATION has stored the history, so the tree is never replayed
      // from a later request's history.
      const stream = this.services.scriptService.regenerateSection(
        request,
        withGenerationSystemPrompt(
          withStructureBlock(messages, buildScriptFs(conversation, examples)),
          buildGenerationSystemPrompt(plan, examples)
        ),
        abortSignal
      )

      const sectionText = await this.streamToString(
        stream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: ensureSectionHeading(request.sectionTitle, accumulated)
          })
        }
      )

      this.completedGenerations.add(generationKey)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        sectionTitle: request.sectionTitle
      })

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: ensureSectionHeading(request.sectionTitle, sectionText)
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // The user stopped the regeneration: keep what streamed in and settle
      // quietly instead of surfacing an error banner
      if (abortSignal?.aborted) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true,
          sectionTitle: request.sectionTitle
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Section regeneration error:', error)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
    }
  }

  // Whole-script refinement: sends the full conversation history plus the
  // user's instruction; the model replies with ONLY the changed sections in
  // "## Section" format, stored as a new generation so consolidation-by-title
  // replaces them in the document
  async refineScript(
    request: RefinementRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const generationKey = `${conversationId}-refine`

    if (!this.activeGenerations.tryStart(generationKey)) return

    try {
      // A fresh refinement run owns generation state from here
      this.callbacks.dispatch({ type: 'GENERATION_RESTARTED', conversationId })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: false
      })

      // Build complete conversation history from all generations, normalised
      // to a single system message (story 8.13)
      const messages = buildConversationHistory(conversation, request.prompt)

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages
      })

      this.persistConversation(conversationId)

      const plan = buildLengthPlan(request.targetMinutes)
      const examples = await this.examplesFor(
        conversationId,
        request.brief?.trim() || request.prompt,
        plan,
        conversation
      )

      // A whole-script refinement decides which sections to rewrite, so it is
      // told what the sections currently are, and which exemplars it has to
      // work from. Send-time only, as above.
      const stream = this.services.scriptService.regenerateSection(
        { prompt: request.prompt, conversationId, sectionTitle: '' },
        withGenerationSystemPrompt(
          withStructureBlock(messages, buildScriptFs(conversation, examples)),
          buildGenerationSystemPrompt(plan, examples)
        ),
        abortSignal
      )

      const responseText = await this.streamToString(
        stream,
        conversationId,
        abortSignal,
        (accumulated) => {
          this.callbacks.dispatch({
            type: 'UPDATE_CURRENT_GENERATION',
            conversationId,
            response: accumulated
          })
        }
      )

      this.callbacks.dispatch({
        type: 'COMPLETE_GENERATION',
        conversationId,
        response: responseText
      })

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true
      })

      this.persistConversation(conversationId)

    } catch (error) {
      // The user stopped the refinement: keep what streamed in
      if (abortSignal?.aborted) {
        this.callbacks.dispatch({
          type: 'SET_GENERATION_PROGRESS',
          conversationId,
          isComplete: true
        })

        this.persistConversation(conversationId)
        return
      }

      console.error('Script refinement error:', error)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    } finally {
      this.activeGenerations.finish(generationKey)
    }
  }
}
