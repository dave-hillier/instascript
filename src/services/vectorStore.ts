import OpenAI from 'openai'

export interface ExampleScript {
  content: string
  metadata?: Record<string, string | number>
  score?: number
}

export class VectorStoreService {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true
    })
  }

  /**
   * Search for relevant example scripts in the vector store
   * @param query User's prompt/query
   * @param limit Maximum number of examples to retrieve
   * @returns Array of relevant example scripts
   */
  async searchExamples(_query: string, limit: number = 3): Promise<ExampleScript[]> {
    try {
      // Note: This is a simplified implementation. In a real implementation,
      // you would use OpenAI's vector search capabilities to find semantically similar content.
      // For now, we'll list files and do basic filtering.
      
      // List all files to find vector store files
      const files = await this.client.files.list({
        purpose: 'assistants'
      })

      if (!files.data || files.data.length === 0) {
        console.warn('No files found')
        return []
      }

      const examples: ExampleScript[] = []

      // Filter for files that might be from our vector store and retrieve content
      for (const file of files.data.slice(0, limit * 2)) {
        try {
          // Check if this might be a markdown file from our vector store
          if (file.filename?.includes('.md') || file.filename?.includes('markdown')) {
            // Get file content
            const fileContent = await this.client.files.content(file.id)
            const content = await fileContent.text()

            // Filter for markdown files only
            if (this.isMarkdownContent(content)) {
              examples.push({
                content,
                metadata: {
                  fileId: file.id,
                  filename: file.filename || 'unknown'
                }
              })

              // Stop once we have enough examples
              if (examples.length >= limit) {
                break
              }
            }
          }
        } catch (error) {
          console.warn(`Failed to retrieve content for file ${file.id}:`, error)
          continue
        }
      }

      console.log(`Found ${examples.length} example scripts from vector store`)
      return examples
    } catch (error) {
      console.error('Vector store search failed:', error)
      return []
    }
  }

  /**
   * Check if content appears to be markdown format
   */
  private isMarkdownContent(content: string): boolean {
    // Check for markdown indicators
    const markdownPatterns = [
      /^#\s+/m,           // Headers
      /^##\s+/m,          // Subheaders  
      /\*\*.*\*\*/,       // Bold text
      /\*.*\*/,           // Italic text
      /^\s*\*\s+/m,       // Bullet points
      /^\s*\d+\.\s+/m     // Numbered lists
    ]

    return markdownPatterns.some(pattern => pattern.test(content))
  }

  /**
   * Format examples for inclusion in prompts
   */
  static formatExamplesForPrompt(examples: ExampleScript[]): string {
    if (examples.length === 0) {
      return ''
    }

    let formatted = '\n\nHere are some example hypnosis scripts for reference:\n\n'
    
    examples.forEach((example, index) => {
      formatted += `### Example ${index + 1}\n`
      formatted += `${example.content}\n\n---\n\n`
    })

    formatted += 'Use these examples as inspiration for structure, language patterns, and therapeutic approaches. Create a new script that follows similar quality and format while being unique and tailored to the user\'s specific request.\n\n'

    return formatted
  }
}