import type { RawConversation } from '../types/conversation'
import { parseConversationDocument } from './responseParser'
import { replaceSection } from './sectionRegeneration'

/**
 * Compose the current state of a script from raw conversation history.
 * This intelligently merges responses to create the current script state.
 */
export const composeCurrentScript = (conversation: RawConversation | undefined): string => {
  if (!conversation || !conversation.generations || conversation.generations.length === 0) {
    return ''
  }

  // For now, use the latest generation's response as the base
  // In the future, this could intelligently merge multiple generations
  const latestGeneration = conversation.generations[conversation.generations.length - 1]
  return latestGeneration?.response || ''
}

/**
 * Compose the script state during section regeneration.
 * Takes the previous complete response and the current section being generated.
 */
export const composeScriptWithLiveSection = (
  conversation: RawConversation | undefined,
  sectionTitle: string,
  liveContent: string
): string => {
  if (!conversation || !conversation.generations || conversation.generations.length === 0) {
    return liveContent
  }

  // Get the latest complete response as the base
  const latestGeneration = conversation.generations[conversation.generations.length - 1]
  const baseResponse = latestGeneration?.response || ''
  
  if (!baseResponse) {
    return liveContent
  }

  // Replace the specific section with the live content
  return replaceSection(baseResponse, sectionTitle, liveContent)
}

/**
 * Get the parsed sections from the current script state
 */
export const getCurrentScriptSections = (conversation: RawConversation | undefined) => {
  const currentScript = composeCurrentScript(conversation)
  if (!currentScript) return []

  const document = parseConversationDocument(currentScript)
  return document.sections.map(section => ({
    id: `section_${section.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    title: section.title,
    content: section.content
  }))
}

/**
 * Check if a conversation is currently generating content
 */
export const isConversationGenerating = (
  conversation: RawConversation | undefined,
  currentGeneration: { conversationId: string; isComplete: boolean } | null
): boolean => {
  if (!conversation || !currentGeneration) return false
  return currentGeneration.conversationId === conversation.id && !currentGeneration.isComplete
}

/**
 * Check if conversation is generating initial content (not regenerating a specific section)
 */
export const isGeneratingInitialContent = (
  conversation: RawConversation | undefined,
  currentGeneration: { conversationId: string; isComplete: boolean; sectionTitle?: string } | null
): boolean => {
  if (!isConversationGenerating(conversation, currentGeneration)) return false
  return !currentGeneration?.sectionTitle
}

/**
 * Check if a specific section is being regenerated
 */
export const isSectionRegenerating = (
  conversation: RawConversation | undefined,
  sectionTitle: string,
  currentGeneration: { conversationId: string; isComplete: boolean; sectionTitle?: string } | null
): boolean => {
  if (!isConversationGenerating(conversation, currentGeneration)) return false
  return currentGeneration?.sectionTitle === sectionTitle
}

/**
 * Get the section title being regenerated, if any
 */
export const getRegeneratingSectionTitle = (
  conversation: RawConversation | undefined,
  currentGeneration: { conversationId: string; isComplete: boolean; sectionTitle?: string } | null
): string | null => {
  if (!isConversationGenerating(conversation, currentGeneration)) return null
  return currentGeneration?.sectionTitle || null
}