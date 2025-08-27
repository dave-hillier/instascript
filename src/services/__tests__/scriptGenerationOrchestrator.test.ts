import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScriptGenerationOrchestrator } from '../scriptGenerationOrchestrator'
import { StreamingState } from '../streamingState'
import type { ScriptServices, GenerationCallbacks } from '../scriptGenerationOrchestrator'

// Mock the content parser
vi.mock('../../utils/contentParser', () => ({
  createSection: vi.fn((title, content) => ({
    id: `mock-section-${title}`,
    title,
    content,
    status: 'generating',
    messageIds: []
  })),
  getSectionTitlesFromContent: vi.fn(() => [])
}))

describe('ScriptGenerationOrchestrator - Content Extraction', () => {
  let orchestrator: ScriptGenerationOrchestrator
  let mockServices: ScriptServices
  let mockCallbacks: GenerationCallbacks

  beforeEach(() => {
    mockServices = {
      scriptService: {
        generateScript: vi.fn()
      },
      exampleService: {
        searchExamples: vi.fn()
      }
    }

    mockCallbacks = {
      dispatch: vi.fn(),
      appDispatch: vi.fn(),
      onRegenerationCheck: vi.fn()
    }

    orchestrator = new ScriptGenerationOrchestrator(mockServices, mockCallbacks)
  })

  describe('extractSectionContent', () => {
    it('should extract clean content without trailing ##', () => {
      const fullContent = `# Script Title

## Progressive Relaxation
Starting with your toes, begin to tense and then release each muscle group...

Complete content here.

##`

      // Access private method via type assertion for testing
      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 2) // Line index of "## Progressive Relaxation"

      expect(result).not.toContain('##')
      expect(result.trim()).toBe(`Starting with your toes, begin to tense and then release each muscle group...

Complete content here.`)
    })

    it('should handle multiple sections properly', () => {
      const fullContent = `# Script Title

## First Section
Content of first section.

## Second Section  
Content of second section.

##`

      const extractMethod = (orchestrator as any).extractSectionContent
      
      // Extract first section content
      const firstResult = extractMethod.call(orchestrator, fullContent, 2)
      expect(firstResult.trim()).toBe('Content of first section.')
      
      // Extract second section content  
      const secondResult = extractMethod.call(orchestrator, fullContent, 5)
      expect(secondResult.trim()).toBe(`Content of second section.`)
      expect(secondResult).not.toContain('##')
    })

    it('should handle incomplete section headers at end', () => {
      const fullContent = `## Complete Section
This has full content.
Multiple lines of content.

## V`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      expect(result.trim()).toBe(`This has full content.
Multiple lines of content.`)
    })

    it('should handle section with just ## at end', () => {
      const fullContent = `## My Section
Good content here.
More good content.

##`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      expect(result).not.toContain('##')
      expect(result.trim()).toBe(`Good content here.
More good content.`)
    })

    it('should handle section with ## plus single character', () => {
      const fullContent = `## First Section
Valid content.

## A`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      // Should stop before the incomplete "## A" 
      expect(result.trim()).toBe('Valid content.')
    })

    it('should preserve valid next section headers', () => {
      const fullContent = `## First Section
Content here.

## Second Complete Section
More content.`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      // Should stop at the valid next section
      expect(result.trim()).toBe('Content here.')
    })

    it('should handle empty sections', () => {
      const fullContent = `## Empty Section

## Next Section`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      expect(result.trim()).toBe('')
    })

    it('should handle section at very end of content', () => {
      const fullContent = `## Final Section
This is the last section.
No more content after this.`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      expect(result.trim()).toBe(`This is the last section.
No more content after this.`)
    })
  })

  describe('Content cleanup edge cases', () => {
    it('should remove multiple incomplete headers at end', () => {
      const fullContent = `## Good Section
Real content.

##
## V
##   `

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      expect(result.trim()).toBe('Real content.')
      expect(result).not.toMatch(/##/)
    })

    it('should preserve content with ## in middle of text', () => {
      const fullContent = `## Section
Some content with ## in the middle of a sentence.
More content.

##`

      const extractMethod = (orchestrator as any).extractSectionContent
      const result = extractMethod.call(orchestrator, fullContent, 0)

      expect(result).toContain('Some content with ## in the middle')
      expect(result).not.toMatch(/\n##\s*$/)
    })

    it('should handle real streaming scenario', () => {
      // Simulate real streaming where content builds up
      const scenarios = [
        '## Progressive',
        '## Progressive Relaxation',
        '## Progressive Relaxation\nStarting with',
        '## Progressive Relaxation\nStarting with your toes',
        '## Progressive Relaxation\nStarting with your toes...\n\n##',
        '## Progressive Relaxation\nStarting with your toes...\n\n## V',
        '## Progressive Relaxation\nStarting with your toes...\n\n## Visualization'
      ]

      const extractMethod = (orchestrator as any).extractSectionContent

      scenarios.forEach((content) => {
        const result = extractMethod.call(orchestrator, content, 0)
        
        // Should never end with incomplete ##
        expect(result).not.toMatch(/##\s*$/)
        
        // Should contain the actual content
        if (content.includes('Starting with your toes')) {
          expect(result).toContain('Starting with your toes')
        }
      })
    })
  })

  describe('Section title evolution during streaming', () => {
    it('should update section titles as they evolve during streaming (E -> Emergence)', () => {
      // Test the StreamingState logic directly
      const streamingState = new StreamingState('test-conversation')
      
      // Start with "E" as section title
      streamingState.startNewSection(0, 'E')
      
      // When we encounter "Emergence", it should NOT create a new section
      // because "Emergence" starts with "E"
      expect(streamingState.shouldCreateNewSection('Emergence')).toBe(false)
      expect(streamingState.shouldCreateNewSection('Em')).toBe(false)
      expect(streamingState.shouldCreateNewSection('Emer')).toBe(false)
      
      // But a completely different title should create a new section
      expect(streamingState.shouldCreateNewSection('Introduction')).toBe(true)
      expect(streamingState.shouldCreateNewSection('Visualization')).toBe(true)
    })

    it('should handle various section title evolution patterns', () => {
      const streamingState = new StreamingState('test-conversation')
      
      // Test case 1: "Visual" -> "Visualization" (extension)
      streamingState.startNewSection(0, 'Visual')
      expect(streamingState.shouldCreateNewSection('Visualization')).toBe(false)
      
      // Test case 2: "Visualization" -> "Visual" (truncation) 
      streamingState.updateCurrentSectionTitle('Visualization')
      expect(streamingState.shouldCreateNewSection('Visual')).toBe(false)
      
      // Test case 3: "Progressive" -> "Progressive Relaxation"
      streamingState.startNewSection(1, 'Progressive')
      expect(streamingState.shouldCreateNewSection('Progressive Relaxation')).toBe(false)
      
      // Test case 4: Different section entirely
      expect(streamingState.shouldCreateNewSection('Breathing')).toBe(true)
    })

    it('should handle edge cases in section title comparison', () => {
      const streamingState = new StreamingState('test-conversation')
      
      // Empty current section should always create new
      expect(streamingState.shouldCreateNewSection('Any Title')).toBe(true)
      
      // Single character extensions
      streamingState.startNewSection(0, 'E')
      expect(streamingState.shouldCreateNewSection('Em')).toBe(false)
      expect(streamingState.shouldCreateNewSection('Emergence')).toBe(false)
      
      // Case sensitivity (should be treated as different sections)
      streamingState.startNewSection(0, 'visual')  
      expect(streamingState.shouldCreateNewSection('Visual')).toBe(true)
    })
  })
})