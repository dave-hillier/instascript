import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScriptGenerationOrchestrator } from '../scriptGenerationOrchestrator'
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
})