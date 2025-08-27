import type { ParsedDocumentHeader, ParsedSection, ConversationDocument } from '../types/conversation'

/**
 * Parse document header (# Title) from a markdown response
 */
export const parseDocumentHeader = (response: string): ParsedDocumentHeader => {
  const lines = response.split('\n')
  const firstLine = lines[0]
  
  // Extract title from first line if it's a markdown header
  const titleMatch = firstLine.match(/^#\s+(.+)$/)
  if (titleMatch) {
    const title = titleMatch[1].trim()
    if (title.length > 0) {
      return {
        title,
        detected: true
      }
    }
  }
  
  return { detected: false }
}

/**
 * Count words in a text string
 */
const countWords = (text: string): number => {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length
}

/**
 * Parse sections (## Section Title) from a markdown response
 */
export const parseSections = (response: string): ParsedSection[] => {
  const lines = response.split('\n')
  const sections: ParsedSection[] = []
  let currentSectionStart = -1
  let currentSectionTitle = ''
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Check if this is a section header (## only, not single #)
    if (line.match(/^##\s+/)) {
      // If we had a previous section, complete it
      if (currentSectionStart >= 0 && currentSectionTitle) {
        const sectionContent = lines.slice(currentSectionStart + 1, i).join('\n').trim()
        sections.push({
          title: currentSectionTitle,
          content: sectionContent,
          wordCount: countWords(sectionContent),
          startLine: currentSectionStart,
          endLine: i - 1
        })
      }
      
      // Start tracking new section
      currentSectionStart = i
      currentSectionTitle = line.match(/##\s+(.+?)$/)?.[1]?.trim() || ''
    }
  }
  
  // Handle the last section if it exists
  if (currentSectionStart >= 0 && currentSectionTitle) {
    const sectionContent = lines.slice(currentSectionStart + 1).join('\n').trim()
    sections.push({
      title: currentSectionTitle,
      content: sectionContent,
      wordCount: countWords(sectionContent),
      startLine: currentSectionStart,
      endLine: lines.length - 1
    })
  }
  
  return sections
}

/**
 * Parse a complete markdown response into a structured document
 */
export const parseConversationDocument = (response: string): ConversationDocument => {
  const header = parseDocumentHeader(response)
  const sections = parseSections(response)
  const totalWordCount = countWords(response)
  
  return {
    header,
    sections,
    fullContent: response,
    totalWordCount
  }
}

import type { RawConversation } from '../types/conversation'

/**
 * Get the latest response content from a raw conversation
 */
export const getLatestContent = (conversation: RawConversation | undefined): string => {
  if (!conversation || !conversation.generations || conversation.generations.length === 0) return ''
  const latestGeneration = conversation.generations[conversation.generations.length - 1]
  return latestGeneration?.response || ''
}


/**
 * Derive current conversation state from raw conversation
 * This returns the parsed version of the composed document
 */
export const deriveConversationState = (conversation: RawConversation | undefined): ConversationDocument | null => {
  if (!conversation || !conversation.generations || conversation.generations.length === 0) return null
  
  const latestGeneration = conversation.generations[conversation.generations.length - 1]
  const composedDocument = latestGeneration?.response || ''
  
  if (!composedDocument) {
    return null
  }
  
  return parseConversationDocument(composedDocument)
}


/**
 * Get the cached tokens from the latest generation for monitoring cache performance
 */
export const getLatestCachedTokens = (conversation: RawConversation | undefined): number | undefined => {
  if (!conversation || !conversation.generations || conversation.generations.length === 0) return undefined
  const latestGeneration = conversation.generations[conversation.generations.length - 1]
  return latestGeneration?.cachedTokens
}