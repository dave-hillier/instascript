import type { RawConversation } from '../types/conversation'
import { deriveConversationState } from './responseParser'
import { 
  composeCurrentScript, 
  getCurrentScriptSections,
  isConversationGenerating,
  isSectionRegenerating
} from './scriptComposition'

export interface ScriptDocumentSection {
  id: string
  title: string
  content: string
  wordCount: number
}

export interface ScriptDocument {
  title?: string
  sections: ScriptDocumentSection[]
  fullContent: string
  isGenerating: boolean
  hasError: boolean
  errorMessage?: string
}

// Type for currentGeneration from the conversation reducer
export interface CurrentGeneration {
  conversationId: string
  isComplete: boolean
  error?: string
  sectionTitle?: string
}

export interface ScriptGenerationState {
  isGenerating: boolean
  shouldDisableRegenerate: boolean
  error?: string
}

/**
 * Get a structured document representation from a conversation
 */
export const getScriptDocument = (
  conversation: RawConversation | undefined,
  currentGeneration: CurrentGeneration | null
): ScriptDocument => {
  const currentScript = composeCurrentScript(conversation)
  
  // Create a temporary conversation document for parsing
  const conversationDocument = currentScript ? deriveConversationState({ 
    id: '', 
    scriptId: '', 
    generations: [{ messages: [], response: currentScript, timestamp: 0 }], 
    createdAt: 0, 
    updatedAt: 0 
  }) : null

  // Get sections from the conversation document or compose from current script
  const baseSections = conversationDocument?.sections || getCurrentScriptSections(conversation)
  
  // Apply live updates during section regeneration and ensure consistent structure
  const sectionsWithLiveUpdates: ScriptDocumentSection[] = baseSections.map(section => {
    const baseSection: ScriptDocumentSection = {
      id: 'id' in section ? section.id : `section_${section.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      title: section.title,
      content: section.content,
      wordCount: 'wordCount' in section ? section.wordCount : 0
    }
    
    if (isSectionRegenerating(conversation, section.title, currentGeneration)) {
      // Get the latest generation's response as the live section content
      const latestGeneration = conversation?.generations?.[conversation.generations.length - 1]
      const liveContent = latestGeneration?.response || ''
      
      return {
        ...baseSection,
        content: liveContent
      }
    }
    return baseSection
  })

  return {
    title: conversationDocument?.header?.title,
    sections: sectionsWithLiveUpdates,
    fullContent: currentScript || '',
    isGenerating: isConversationGenerating(conversation, currentGeneration),
    hasError: !!currentGeneration?.error,
    errorMessage: currentGeneration?.error
  }
}

/**
 * Get generation state information
 */
export const getScriptGenerationState = (
  conversation: RawConversation | undefined,
  currentGeneration: CurrentGeneration | null
): ScriptGenerationState => {
  const isGenerating = isConversationGenerating(conversation, currentGeneration)
  
  return {
    isGenerating,
    shouldDisableRegenerate: isGenerating,
    error: currentGeneration?.error
  }
}


/**
 * Format section content for display, filtering out section headers
 */
export const formatSectionContent = (content: string): Array<{ text: string; key: string }> => {
  return content
    .split('\n')
    .map((line, index) => ({ text: line, key: `line-${index}` }))
    .filter(({ text }) => !text.startsWith('## ') && text.trim())
}

/**
 * Format full script content for display when no sections are available
 */
export const formatFullScriptContent = (content: string): Array<{ text: string; key: string }> => {
  return content
    .split('\n')
    .map((paragraph, index) => ({ text: paragraph, key: `paragraph-${index}` }))
    .filter(({ text }) => text.trim())
}