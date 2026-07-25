import type { RawConversation, GenerationRequest, RegenerationRequest, RefinementRequest, ChatMessage, ReviewRevision, ScriptOutline } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversationAction } from '../reducers/rawConversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt, getOutlineGenerationPrompt, getSectionGenerationPrompt, buildStyleCritiquePrompt, buildSectionRegenerationPromptFromConversation } from './prompts'
import { getRecommendedExampleCount } from '../utils/contextWindow'
import { countWords, formatScriptLength } from '../utils/scriptMetrics'
import { parseOutline, ensureSectionHeading, consolidateSections } from './conversationDocument'
import { shouldRetrySection, pickBetterSectionText, buildRetryNote } from './sectionQuality'
import { parseCritiqueResponse, selectViolationsToRevise, buildRevisionInstruction, STYLE_REVIEW_SECTION_TITLE } from './critiquePass'
import { KeyedRunGuard } from './runLifecycle'

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

  constructor(
    services: RawScriptServices,
    callbacks: RawGenerationCallbacks,
    options: RawGenerationOptions = {}
  ) {
    this.services = services
    this.callbacks = callbacks
    this.options = options
  }

  private async retrieveExamples(
    request: GenerationRequest,
    conversation: RawConversation | undefined
  ): Promise<ExampleScript[]> {
    try {
      const systemPrompt = getSystemPrompt()
      const conversationTokens = conversation
        ? conversation.generations.reduce((total: number, generation) => total + generation.response.length, 0)
        : 0
      const optimalExampleCount = getRecommendedExampleCount(
        systemPrompt,
        Math.ceil(conversationTokens / 4)
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
      const examples = await this.retrieveExamples(request, conversation)
      const exampleIds = examples
        .map(example => String(example.metadata?.id ?? example.metadata?.filename ?? ''))
        .filter(Boolean)

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

        const outlineUserPrompt = request.prompt + '\n\n' + getOutlineGenerationPrompt()

        // Start a generation entry for the outline
        this.callbacks.dispatch({
          type: 'START_GENERATION',
          conversationId,
          messages: [
            { role: 'system', content: getSystemPrompt() },
            { role: 'user', content: outlineUserPrompt }
          ],
          exampleIds: exampleIds.length > 0 ? exampleIds : undefined
        })

        const outlineStream = this.services.scriptService.generateScript(
          { ...request, prompt: outlineUserPrompt },
          [],
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

        const sectionPrompt = getSectionGenerationPrompt(section.title, section.description)
        const sectionUserMessage = `Here is the outline for the full script:\n\n${outlineText}\n\nHere is what has been written so far:\n\n${scriptContent}\n\n${sectionPrompt}`

        const runSectionAttempt = async (userMessage: string): Promise<string> => {
          const sectionMessages: ChatMessage[] = [
            { role: 'system', content: getSystemPrompt() },
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
            sectionMessages,
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
        reviewResult = await this.runReviewPass(conversation, outline, scriptContent, abortSignal)
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
          report: { conversationId, revised: reviewResult.revised }
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

  // Style-review pass (story 8.5): one critique request checks the finished
  // script against the style rules, then up to MAX_REVIEW_REVISIONS violating
  // sections are regenerated once each through the ordinary
  // section-regeneration path with the violation as the instruction. A
  // failed or stopped review never fails the completed generation.
  private async runReviewPass(
    conversation: RawConversation,
    outline: ScriptOutline,
    scriptContent: string,
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
          { prompt, conversationId, sectionTitle: violation.sectionTitle },
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

      // Build complete conversation history from all generations
      const messages: ChatMessage[] = []

      for (const generation of conversation.generations) {
        messages.push(...generation.messages)
        if (generation.response) {
          messages.push({ role: 'assistant', content: generation.response })
        }
      }

      messages.push({ role: 'user', content: request.prompt })

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages
      })

      this.persistConversation(conversationId)

      const stream = this.services.scriptService.regenerateSection(
        request,
        messages,
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

      // Build complete conversation history from all generations
      const messages: ChatMessage[] = []

      for (const generation of conversation.generations) {
        messages.push(...generation.messages)
        if (generation.response) {
          messages.push({ role: 'assistant', content: generation.response })
        }
      }

      messages.push({ role: 'user', content: request.prompt })

      this.callbacks.dispatch({
        type: 'START_GENERATION',
        conversationId,
        messages
      })

      this.persistConversation(conversationId)

      const stream = this.services.scriptService.regenerateSection(
        { prompt: request.prompt, conversationId, sectionTitle: '' },
        messages,
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
