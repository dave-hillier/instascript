import type { 
  RegenerationState, 
  SectionAnalysis, 
  SectionRegenerationState 
} from '../types/regeneration'
import type { Conversation, ConversationSection } from '../types/conversation'
import type { Job } from '../types/job'

/**
 * Create section key for consistent identification
 */
export const createSectionKey = (scriptId: string, sectionId: string): string => 
  `${scriptId}:${sectionId}`

/**
 * Get section regeneration state, creating default if not exists
 */
export const getSectionState = (
  state: RegenerationState, 
  sectionKey: string
): SectionRegenerationState => {
  return state.sectionStates[sectionKey] || {
    sectionKey,
    attempts: 0,
    lastRegenerationTime: 0,
    isInCooldown: false,
    nextEligibleTime: 0
  }
}

/**
 * Check if section is currently in cooldown
 */
export const isSectionInCooldown = (
  state: RegenerationState,
  sectionKey: string,
  currentTime: number = Date.now()
): boolean => {
  const sectionState = getSectionState(state, sectionKey)
  return sectionState.nextEligibleTime > currentTime
}

/**
 * Check if section has exceeded maximum attempts
 */
export const hasExceededMaxAttempts = (
  state: RegenerationState,
  sectionKey: string
): boolean => {
  const sectionState = getSectionState(state, sectionKey)
  return sectionState.attempts >= state.rules.maxAutoRegenerationAttempts
}

/**
 * Get remaining cooldown time in milliseconds
 */
export const getRemainingCooldown = (
  state: RegenerationState,
  sectionKey: string,
  currentTime: number = Date.now()
): number => {
  const sectionState = getSectionState(state, sectionKey)
  return Math.max(0, sectionState.nextEligibleTime - currentTime)
}

/**
 * Count words in content
 */
export const countWords = (content: string): number => {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length
}

/**
 * Analyze a single section for regeneration eligibility
 */
export const analyzeSection = (
  state: RegenerationState,
  section: ConversationSection,
  scriptId: string,
  existingJobs: Job[],
  currentTime: number = Date.now()
): SectionAnalysis => {
  const sectionKey = createSectionKey(scriptId, section.id)
  const sectionState = getSectionState(state, sectionKey)
  const wordCount = countWords(section.content)

  // Check if there's already a regeneration job for this section
  const hasExistingJob = existingJobs.some(job =>
    job.type === 'regenerate-section' &&
    job.scriptId === scriptId &&
    job.sectionId === section.id &&
    (job.status === 'queued' || job.status === 'processing')
  )

  const isInCooldown = isSectionInCooldown(state, sectionKey, currentTime)
  const exceedsMaxAttempts = hasExceededMaxAttempts(state, sectionKey)
  const meetsWordRequirement = wordCount >= state.rules.minimumWordCount
  const isCompleted = section.status === 'completed'

  let needsRegeneration = false
  let reason: string

  if (hasExistingJob) {
    reason = 'Already has regeneration job in progress'
  } else if (exceedsMaxAttempts) {
    reason = `Exceeded maximum auto-regeneration attempts (${sectionState.attempts}/${state.rules.maxAutoRegenerationAttempts})`
  } else if (isInCooldown) {
    const remainingSeconds = Math.ceil(getRemainingCooldown(state, sectionKey, currentTime) / 1000)
    reason = `In cooldown period (${remainingSeconds}s remaining)`
  } else if (!isCompleted) {
    reason = 'Section not yet completed'
  } else if (meetsWordRequirement) {
    reason = 'Meets word count requirements'
  } else {
    needsRegeneration = true
    reason = `Below minimum word count (${wordCount}/${state.rules.minimumWordCount})`
  }

  return {
    sectionId: section.id,
    sectionTitle: section.title,
    wordCount,
    needsRegeneration,
    reason,
    attempts: sectionState.attempts,
    isInCooldown
  }
}

/**
 * Analyze all sections in a conversation
 */
export const analyzeSections = (
  state: RegenerationState,
  conversation: Conversation,
  existingJobs: Job[],
  currentTime: number = Date.now()
): SectionAnalysis[] => {
  return conversation.sections.map(section =>
    analyzeSection(state, section, conversation.scriptId, existingJobs, currentTime)
  )
}

/**
 * Get sections that need regeneration
 */
export const getSectionsNeedingRegeneration = (
  state: RegenerationState,
  conversation: Conversation,
  existingJobs: Job[],
  currentTime: number = Date.now()
): SectionAnalysis[] => {
  const analyses = analyzeSections(state, conversation, existingJobs, currentTime)
  return analyses.filter(analysis => analysis.needsRegeneration)
}

/**
 * Get regeneration statistics for debugging
 */
export const getRegenerationStats = (state: RegenerationState) => {
  const sectionStates = Object.values(state.sectionStates)
  const totalAttempts = sectionStates.reduce((sum, sectionState) => sum + sectionState.attempts, 0)
  const sectionsTracked = sectionStates.length
  const averageAttempts = sectionsTracked > 0 ? totalAttempts / sectionsTracked : 0
  const sectionsInCooldown = sectionStates.filter(s => s.isInCooldown).length
  const sectionsExceedingMax = sectionStates.filter(s => 
    s.attempts >= state.rules.maxAutoRegenerationAttempts
  ).length

  return {
    totalAttempts,
    sectionsTracked,
    averageAttempts: Math.round(averageAttempts * 100) / 100,
    sectionsInCooldown,
    sectionsExceedingMax,
    totalRegenerationsRequested: state.totalRegenerationsRequested,
    lastAnalysisTime: state.lastAnalysisTime
  }
}