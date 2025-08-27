import { parseSections } from './responseParser'

/**
 * Replace a specific section in a markdown document with new content
 */
export const replaceSection = (
  originalDocument: string,
  sectionTitle: string,
  newSectionContent: string
): string => {
  const lines = originalDocument.split('\n')
  const result: string[] = []
  
  let inTargetSection = false
  let foundSection = false
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Check if this is a section header (## Title)
    if (line.match(/^##\s+/)) {
      const currentSectionTitle = line.match(/##\s+(.+?)$/)?.[1]?.trim()
      
      if (currentSectionTitle === sectionTitle) {
        // Found the target section to replace
        inTargetSection = true
        foundSection = true
        
        // Add the section header and new content
        result.push(line) // Keep original header
        result.push('') // Empty line
        
        // Add the new section content (clean it up)
        const cleanContent = newSectionContent
          .split('\n')
          .filter(contentLine => !contentLine.match(/^##\s+/)) // Remove any duplicate headers
          .join('\n')
          .trim()
        
        result.push(cleanContent)
        result.push('') // Empty line after section
      } else {
        // Different section - stop replacing if we were in target section
        if (inTargetSection) {
          inTargetSection = false
        }
        result.push(line)
      }
    } else if (inTargetSection) {
      // Skip lines inside the target section (they're being replaced)
      continue
    } else {
      // Keep all other lines
      result.push(line)
    }
  }
  
  // If section wasn't found, append it at the end
  if (!foundSection) {
    result.push('')
    result.push(`## ${sectionTitle}`)
    result.push('')
    result.push(newSectionContent.trim())
  }
  
  return result.join('\n').trim()
}

/**
 * Extract the current content of a specific section
 */
export const extractSectionContent = (document: string, sectionTitle: string): string => {
  const sections = parseSections(document)
  const targetSection = sections.find(section => section.title === sectionTitle)
  return targetSection?.content || ''
}

/**
 * Get context around a section for better regeneration prompts
 */
export const getSectionContext = (document: string, sectionTitle: string): {
  documentTitle?: string
  allSectionTitles: string[]
  sectionIndex: number
} => {
  const sections = parseSections(document)
  const sectionIndex = sections.findIndex(section => section.title === sectionTitle)
  
  // Extract document title
  const titleMatch = document.match(/^#\s+(.+?)$/m)
  const documentTitle = titleMatch ? titleMatch[1].trim() : undefined
  
  return {
    documentTitle,
    allSectionTitles: sections.map(s => s.title),
    sectionIndex
  }
}