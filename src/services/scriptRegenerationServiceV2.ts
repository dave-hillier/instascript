import type { Conversation } from '../types/conversation'
import type { Job } from '../types/job'
import type { RegenerationState, RegenerationAction, SectionAnalysis } from '../types/regeneration'
import { messageBus } from './messageBus'
import { 
  analyzeSections, 
  getSectionsNeedingRegeneration,
  createSectionKey,
  getRegenerationStats 
} from '../selectors/regenerationSelectors'

/**
 * Pure service class that coordinates regeneration logic using reducer state
 * No internal mutable state - all state lives in RegenerationProvider
 */
export class ScriptRegenerationServiceV2 {
  private dispatch: ((action: RegenerationAction) => void) | null = null
  private autoRegenerationHandler: ((conversationId: string) => void) | null = null

  constructor() {
    this.setupMessageHandlers()
  }

  /**
   * Set the dispatch function from the RegenerationProvider
   */
  setDispatch(dispatch: (action: RegenerationAction) => void): void {
    this.dispatch = dispatch
  }

  /**
   * Set the auto-regeneration handler from the ConversationProvider
   */
  setAutoRegenerationHandler(handler: (conversationId: string) => void): void {
    this.autoRegenerationHandler = handler
  }

  private setupMessageHandlers(): void {
    messageBus.subscribe('SCRIPT_GENERATION_COMPLETED', (payload) => {
      this.handleScriptGenerationCompleted(payload.conversationId, payload.scriptId)
    })

    messageBus.subscribe('SECTION_REGENERATION_COMPLETED', (payload) => {
      this.handleSectionRegenerationCompleted(payload.conversationId, payload.scriptId, payload.sectionId)
    })
  }

  private handleScriptGenerationCompleted(conversationId: string, scriptId: string): void {
    console.log('[ScriptRegenerationServiceV2] Script generation completed', {
      conversationId,
      scriptId
    })

    // Auto-regeneration will be triggered by ConversationProvider after sections are marked as completed
    console.log('[ScriptRegenerationServiceV2] Auto-regeneration will be triggered after sections are completed')
  }

  private handleSectionRegenerationCompleted(conversationId: string, scriptId: string, sectionId: string): void {
    console.log('[ScriptRegenerationServiceV2] Section regeneration completed, checking for additional auto-regeneration', {
      conversationId,
      scriptId,
      sectionId
    })

    // Update state to track this regeneration attempt
    if (this.dispatch) {
      const sectionKey = createSectionKey(scriptId, sectionId)
      this.dispatch({
        type: 'REGENERATION_ATTEMPTED',
        sectionKey,
        timestamp: Date.now(),
        isManual: false
      })
    }

    // Trigger auto-regeneration check for other sections via direct handler call
    if (this.autoRegenerationHandler) {
      this.autoRegenerationHandler(conversationId)
    }
  }

  /**
   * Analyze conversation sections using pure selector functions
   */
  analyzeSections(
    state: RegenerationState,
    conversation: Conversation, 
    existingJobs: Job[]
  ): SectionAnalysis[] {
    // Update analysis time
    if (this.dispatch) {
      // Initialize section states for any new sections
      conversation.sections.forEach(section => {
        const sectionKey = createSectionKey(conversation.scriptId, section.id)
        this.dispatch!({
          type: 'SECTION_STATE_INITIALIZED',
          sectionKey
        })
      })
    }

    return analyzeSections(state, conversation, existingJobs)
  }

  /**
   * Request regeneration for the first section that needs it (sequential processing)
   */
  requestRegenerations(
    conversation: Conversation, 
    sectionsToRegenerate: SectionAnalysis[]
  ): void {
    // Sort sections by their order in the conversation to maintain sequence
    const sortedSections = sectionsToRegenerate
      .filter(analysis => analysis.needsRegeneration)
      .sort((a, b) => {
        const aIndex = conversation.sections.findIndex(s => s.id === a.sectionId)
        const bIndex = conversation.sections.findIndex(s => s.id === b.sectionId)
        return aIndex - bIndex
      })

    if (sortedSections.length === 0) return

    // Only queue the FIRST section that needs regeneration
    // When it completes, it will trigger another check and queue the next one
    const firstSection = sortedSections[0]
    const sectionKey = createSectionKey(conversation.scriptId, firstSection.sectionId)

    console.log('[ScriptRegenerationServiceV2] Requesting next auto-regeneration (sequential)', {
      totalSectionsNeedingRegen: sortedSections.length,
      currentSection: firstSection.sectionTitle,
      wordCount: firstSection.wordCount,
      remainingSections: sortedSections.slice(1).map(s => s.sectionTitle)
    })
    
    // Track regeneration attempt in state
    if (this.dispatch) {
      this.dispatch({
        type: 'REGENERATION_ATTEMPTED',
        sectionKey,
        timestamp: Date.now(),
        isManual: false
      })
    }

    console.log('[ScriptRegenerationServiceV2] Queueing next section for regeneration', {
      sectionId: firstSection.sectionId,
      sectionTitle: firstSection.sectionTitle,
      wordCount: firstSection.wordCount,
      attempt: firstSection.attempts + 1,
      reason: firstSection.reason
    })

    messageBus.publish('REGENERATE_SECTION_REQUESTED', {
      scriptId: conversation.scriptId,
      sectionId: firstSection.sectionId,
      sectionTitle: firstSection.sectionTitle,
      conversationId: conversation.id
    })
  }

  /**
   * Handle manual regeneration request (resets attempt counter)
   */
  requestManualRegeneration(
    scriptId: string,
    sectionId: string,
    sectionTitle: string,
    conversationId: string
  ): void {
    const sectionKey = createSectionKey(scriptId, sectionId)
    
    // Reset attempt counter for manual regeneration
    if (this.dispatch) {
      this.dispatch({
        type: 'ATTEMPTS_RESET',
        sectionKey,
        reason: 'manual_request'
      })

      // Then track the new attempt
      this.dispatch({
        type: 'REGENERATION_ATTEMPTED',
        sectionKey,
        timestamp: Date.now(),
        isManual: true
      })
    }

    console.log('[ScriptRegenerationServiceV2] Requesting manual regeneration', {
      sectionId,
      sectionTitle
    })

    messageBus.publish('REGENERATE_SECTION_REQUESTED', {
      scriptId,
      sectionId,
      sectionTitle,
      conversationId
    })
  }

  /**
   * Handle auto-regeneration check using pure functions
   */
  handleAutoRegenerationCheck(
    state: RegenerationState,
    conversation: Conversation,
    existingJobs: Job[]
  ): void {
    console.log('[ScriptRegenerationServiceV2] Handling auto-regeneration check request', { 
      conversationId: conversation.id 
    })
    
    // Use pure selector to analyze all sections (not just those needing regeneration)
    const allSectionAnalyses = analyzeSections(state, conversation, existingJobs)
    const sectionsToRegenerate = allSectionAnalyses.filter(analysis => analysis.needsRegeneration)
    
    console.log('[ScriptRegenerationServiceV2] Section analysis results:', {
      totalSections: conversation.sections.length,
      allSections: allSectionAnalyses.map(s => ({
        title: s.sectionTitle,
        status: conversation.sections.find(section => section.id === s.sectionId)?.status,
        wordCount: s.wordCount,
        needsRegeneration: s.needsRegeneration,
        reason: s.reason,
        attempts: s.attempts
      })),
      minimumWordCount: state.rules.minimumWordCount,
      maxAttempts: state.rules.maxAutoRegenerationAttempts
    })
    
    if (sectionsToRegenerate.length > 0) {
      console.log('[ScriptRegenerationServiceV2] Auto-regeneration analysis complete', {
        totalSections: conversation.sections.length,
        needingRegeneration: sectionsToRegenerate.length,
        sections: sectionsToRegenerate.map(s => ({ 
          title: s.sectionTitle, 
          wordCount: s.wordCount, 
          reason: s.reason 
        }))
      })
      
      this.requestRegenerations(conversation, sectionsToRegenerate)
    } else {
      console.log('[ScriptRegenerationServiceV2] No sections need auto-regeneration', {
        totalSections: conversation.sections.length
      })
    }
  }

  /**
   * Update regeneration rules
   */
  updateRules(newRules: Partial<RegenerationState['rules']>): void {
    if (this.dispatch) {
      this.dispatch({
        type: 'RULES_UPDATED',
        rules: newRules
      })
    }
    console.log('[ScriptRegenerationServiceV2] Rules updated', newRules)
  }

  /**
   * Get regeneration statistics using pure selector
   */
  getRegenerationStats(state: RegenerationState) {
    return getRegenerationStats(state)
  }

  /**
   * Clear all tracking data
   */
  clearTrackingData(reason: 'test' | 'admin' = 'admin'): void {
    if (this.dispatch) {
      this.dispatch({
        type: 'TRACKING_DATA_CLEARED',
        reason
      })
    }
  }
}

// Single instance for the entire app
export const scriptRegenerationServiceV2 = new ScriptRegenerationServiceV2()