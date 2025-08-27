import type { ConversationSection } from '../types/conversation'

export interface TitleExtractionResult {
  title?: string
  detected: boolean
}

export interface SectionParsingResult {
  currentSectionStart: number
  currentSectionTitle: string
  sectionsToComplete: string[]
}

export const extractTitle = (content: string): TitleExtractionResult => {
  const lines = content.split('\n')
  const firstLine = lines[0]
  
  // Extract title eagerly - even from partial lines
  const titleMatch = firstLine.match(/^#\s+(.*)$/)
  if (titleMatch) {
    const title = titleMatch[1].trim()
    // Only return a title if we have some content after the #
    if (title.length > 0) {
      return {
        title,
        detected: true
      }
    }
  }
  
  return { detected: false }
}

export const parseSectionsFromContent = (
  content: string
): { sectionStart: number; sectionTitle: string; sectionContent?: string }[] => {
  const lines = content.split('\n')
  const sections: { sectionStart: number; sectionTitle: string; sectionContent?: string }[] = []
  let currentSectionStart = -1
  let currentSectionTitle = ''
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Check if this is a section header (## only, not single #)
    // Process eagerly - even partial headers
    if (line.match(/^##\s+/)) {
      // If we had a previous section, add it to results
      if (currentSectionStart >= 0 && currentSectionTitle) {
        const sectionContent = lines.slice(currentSectionStart, i).join('\n').trim()
        sections.push({
          sectionStart: currentSectionStart,
          sectionTitle: currentSectionTitle,
          sectionContent
        })
      }
      
      // Start tracking new section
      currentSectionStart = i
      currentSectionTitle = line.match(/##\s+(.+?)$/)?.[1]?.trim() || ''
    }
  }
  
  // Handle the last section if it exists (including partial ones)
  if (currentSectionStart >= 0) {
    const sectionContent = lines.slice(currentSectionStart).join('\n').trim()
    sections.push({
      sectionStart: currentSectionStart,
      sectionTitle: currentSectionTitle,
      sectionContent
    })
  }
  
  return sections
}

export const createSection = (title: string, content: string): ConversationSection => {
  return {
    id: `section_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    title,
    content,
    status: 'generating',
    messageIds: []
  }
}

export const getSectionTitlesFromContent = (content: string): string[] => {
  const sectionMatches = content.match(/##\s+(.+?)(?=\n##|\n$|$)/gs) || []
  
  return sectionMatches.map(match => {
    const titleMatch = match.match(/##\s+(.+?)(?=\n|$)/)
    return titleMatch ? titleMatch[1].trim() : ''
  }).filter(title => title !== '')
}