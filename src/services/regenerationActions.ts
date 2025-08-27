import type { Conversation } from '../types/conversation'
import { 
  analyzeSections, 
  getNextSectionToRegenerate,
  type RegenerationConfig 
} from './regeneration'
import type { Job } from '../types/job'

/**
 * Pure actions for regeneration logic - no side effects
 * These functions return data that can be used by React components
 */

export interface RegenerationRequest {
  scriptId: string
  sectionId: string
  sectionTitle: string
  conversationId: string
}

export interface RegenerationAnalysis {
  nextRequest: RegenerationRequest | null
  allSections: ReturnType<typeof analyzeSections>
}

/**
 * Analyze a conversation and return what should be regenerated next
 */
export function analyzeConversationForRegeneration(
  conversation: Conversation,
  config: RegenerationConfig,
  existingJobs: Job[]
): RegenerationAnalysis {
  
  const allSections = analyzeSections(conversation, config, existingJobs)
  const nextSection = getNextSectionToRegenerate(conversation, config, existingJobs)
  
  let nextRequest: RegenerationRequest | null = null
  if (nextSection) {
    nextRequest = {
      scriptId: conversation.scriptId,
      sectionId: nextSection.sectionId,
      sectionTitle: nextSection.sectionTitle,
      conversationId: conversation.id
    }
  }

  return {
    nextRequest,
    allSections
  }
}

/**
 * Create a manual regeneration request
 */
export function createManualRegenerationRequest(
  scriptId: string,
  sectionId: string,
  sectionTitle: string,
  conversationId: string
): RegenerationRequest {
  return {
    scriptId,
    sectionId,
    sectionTitle,
    conversationId
  }
}