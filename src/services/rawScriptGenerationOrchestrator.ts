import type { RawConversation, GenerationRequest, RegenerationRequest, ChatMessage, ScriptOutline, OutlineSection } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversationAction } from '../reducers/rawConversationReducer'
import type { Script } from '../types/script'
import { getSystemPrompt, getOutlineGenerationPrompt, getSectionGenerationPrompt } from './prompts'
import { getRecommendedExampleCount } from '../utils/contextWindow'

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

function parseOutline(text: string): ScriptOutline | null {
  const lines = text.trim().split('\n')
  const titleMatch = lines[0]?.match(/^#\s+(.+)$/)
  if (!titleMatch) return null

  const title = titleMatch[1].trim()
  const sections: OutlineSection[] = []
  let currentSectionTitle = ''

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const sectionMatch = line.match(/^##\s+(.+)$/)
    if (sectionMatch) {
      // If we had a previous section without a description, add it
      if (currentSectionTitle && !sections.find(s => s.title === currentSectionTitle)) {
        sections.push({ title: currentSectionTitle, description: '' })
      }
      currentSectionTitle = sectionMatch[1].trim()
    } else if (currentSectionTitle && line.trim() && !sections.find(s => s.title === currentSectionTitle)) {
      sections.push({ title: currentSectionTitle, description: line.trim() })
    }
  }

  // Handle last section if no description was found
  if (currentSectionTitle && !sections.find(s => s.title === currentSectionTitle)) {
    sections.push({ title: currentSectionTitle, description: '' })
  }

  if (sections.length === 0) return null
  return { title, sections }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length
}

export class RawScriptGenerationOrchestrator {
  private services: RawScriptServices
  private callbacks: RawGenerationCallbacks
  private activeGenerations = new Set<string>()
  private completedGenerations = new Set<string>()
  private lastSaveTime = 0
  private saveThrottleMs = 1000

  constructor(
    services: RawScriptServices,
    callbacks: RawGenerationCallbacks
  ) {
    this.services = services
    this.callbacks = callbacks
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

    if (this.activeGenerations.has(generationKey)) return
    this.activeGenerations.add(generationKey)

    try {
      // Retrieve examples upfront
      const examples = await this.retrieveExamples(request, conversation)

      if (abortSignal?.aborted) throw new Error('Generation aborted')

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
        ]
      })

      const outlineStream = this.services.scriptService.generateScript(
        { ...request, prompt: outlineUserPrompt },
        [],
        examples,
        abortSignal
      )

      const outlineText = await this.streamToString(
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
      const outline = parseOutline(outlineText)
      if (!outline) {
        throw new Error('Failed to parse outline from LLM response')
      }

      if (abortSignal?.aborted) throw new Error('Generation aborted')

      // --- Phase 2: Generate sections one at a time ---
      const sectionWordCounts: number[] = []

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PHASE',
        conversationId,
        phase: 'generating_section',
        outline,
        currentSectionIndex: 0,
        totalSections: outline.sections.length,
        sectionWordCounts
      })

      let scriptContent = `# ${outline.title}`

      for (let i = 0; i < outline.sections.length; i++) {
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

        const sectionMessages: ChatMessage[] = [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: request.prompt },
          { role: 'assistant', content: outlineText },
          { role: 'user', content: sectionUserMessage }
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
          { prompt: sectionUserMessage, conversationId, sectionTitle: section.title },
          sectionMessages,
          abortSignal
        )

        const sectionText = await this.streamToString(
          sectionStream,
          conversationId,
          abortSignal,
          (accumulated) => {
            this.callbacks.dispatch({
              type: 'UPDATE_CURRENT_GENERATION',
              conversationId,
              response: `## ${section.title}\n${accumulated}`
            })
          }
        )

        const wordCount = countWords(sectionText)
        sectionWordCounts.push(wordCount)

        scriptContent += `\n\n## ${section.title}\n${sectionText}`

        this.callbacks.dispatch({
          type: 'COMPLETE_GENERATION',
          conversationId,
          response: `## ${section.title}\n${sectionText}`
        })

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

      this.persistConversation(conversationId)

    } catch (error) {
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

      throw error
    } finally {
      this.activeGenerations.delete(generationKey)
    }
  }

  async regenerateSection(
    request: RegenerationRequest,
    conversation: RawConversation,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const conversationId = conversation.id
    const generationKey = `${conversationId}-${request.sectionTitle}`

    if (this.activeGenerations.has(generationKey)) return
    this.activeGenerations.add(generationKey)

    try {
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
            response: accumulated
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
        response: sectionText
      })

      this.persistConversation(conversationId)

    } catch (error) {
      console.error('Section regeneration error:', error)

      this.callbacks.dispatch({
        type: 'SET_GENERATION_PROGRESS',
        conversationId,
        isComplete: true,
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      throw error
    } finally {
      this.activeGenerations.delete(generationKey)
    }
  }
}
