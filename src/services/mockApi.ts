import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { ScriptGenerationService } from './scriptGenerationService'

export class MockAPIService implements ScriptGenerationService {
  constructor() {
    console.warn('MockAPIService is being used - this should only be used for testing!')
  }

  private async delay(min: number, max?: number, reason?: string): Promise<void> {
    const ms = max ? Math.random() * (max - min) + min : min
    if (reason) {
      // Simulated delay
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private splitIntoRealisticChunks(content: string): string[] {
    const chunks: string[] = []
    
    // Split content into words while preserving spaces and newlines
    const tokens = content.match(/\S+|\s+|\n/g) || []
    
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      
      // Randomly choose streaming granularity
      const rand = Math.random()
      
      if (rand < 0.15) {
        // 15% chance: Stream character by character for this token
        for (const char of token) {
          chunks.push(char)
        }
      } else if (rand < 0.8) {
        // 65% chance: Stream token by token (most common)
        chunks.push(token)
      } else {
        // 20% chance: Group 2-4 tokens together
        let group = token
        const numToGroup = Math.floor(Math.random() * 3) + 1
        
        for (let j = 1; j <= numToGroup && i + j < tokens.length; j++) {
          group += tokens[i + j]
        }
        
        chunks.push(group)
        i += numToGroup // Skip the grouped tokens
      }
    }
    
    return chunks
  }

  private generateExpandedSectionContent(sectionTitle: string): string {
    // Generate expanded section content with at least 400 words
    const title = sectionTitle.replace(/^## /, '')
    
    return `## ${title}

Welcome to this expanded and enriched section designed to provide deeper therapeutic benefits. As you continue this journey of personal growth and healing, allow yourself to fully embrace the transformative power of this moment. Each word you hear, each breath you take, and each sensation you experience is guiding you toward a more balanced and centered state of being.

In this space of deep relaxation and inner awareness, your subconscious mind is naturally receptive to positive change and healing suggestions. You may notice how effortlessly your body begins to release tension, starting from the very top of your head and flowing like warm, golden light through every fiber of your being. This gentle wave of relaxation moves down through your forehead, relaxing the muscles around your eyes, softening your jaw, and releasing any stored tension in your neck and shoulders.

As this peaceful sensation continues its journey through your body, you become increasingly aware of your natural capacity for healing and renewal. Your breathing becomes deeper and more rhythmic, each inhalation bringing in fresh energy and vitality, while each exhalation releases any stress, worry, or negativity that no longer serves your highest good.

Within this sanctuary of inner peace, your mind naturally begins to organize and integrate the day's experiences, filing away what is useful and gently releasing what is no longer needed. You may find that solutions to challenges begin to emerge with remarkable clarity, as if your inner wisdom is finally free to express itself without the interference of daily distractions and concerns.

The therapeutic benefits of this experience extend far beyond this single session, creating lasting positive changes in how you perceive yourself and interact with the world around you. With each passing moment, you are building new neural pathways that support confidence, resilience, and inner strength. These positive changes become more deeply embedded with each practice, creating a solid foundation for ongoing personal growth and emotional well-being.

As this section draws to a gentle close, take a moment to appreciate the profound work you have done here today. Your commitment to self-improvement and healing is truly admirable, and the benefits of this experience will continue to unfold in the days and weeks ahead, bringing you greater peace, clarity, and joy in all aspects of your life.`
  }

  private generateScriptContent(prompt: string): string {
    // Generate different content based on the prompt
    if (prompt.toLowerCase().includes('confidence') || prompt.toLowerCase().includes('speaking')) {
      return `# Confidence Building for Public Speaking Script

## Introduction
Welcome to this confidence-building session designed specifically for public speaking success.

## Induction
Take a deep breath and allow yourself to settle into a comfortable, relaxed state...

## Building Inner Confidence
You are naturally confident and capable. Your voice carries wisdom and value...

## Visualization of Success
See yourself speaking with clarity, confidence, and natural ease...

## Anchoring Confidence
This feeling of confidence is now anchored within you...

## Emergence
Returning now, feeling confident and ready to share your voice with the world...`
    } else if (prompt.toLowerCase().includes('sleep') || prompt.toLowerCase().includes('insomnia')) {
      return `# Sleep Improvement & Deep Rest Script

## Evening Preparation
As you prepare for sleep tonight, your mind and body naturally begin to unwind...

## Progressive Relaxation
Starting from the top of your head, allow deep relaxation to flow through your entire being...

## Mental Clearing
Like gentle waves washing away footprints in the sand, let your thoughts drift peacefully away...

## Sleep Induction
Your body knows exactly how to achieve deep, restorative sleep...

## Deep Sleep Suggestions
Throughout the night, you sleep peacefully and wake feeling refreshed...

## Gentle Awakening
When morning comes, you awaken naturally, feeling energized and ready for the day...`
    } else {
      // Default relaxation script
      return `# Deep Relaxation & Stress Relief Script

## Introduction
Welcome to this deep relaxation session. Find a comfortable position where you can remain undisturbed for the next 20 minutes.

## Induction
As you close your eyes, take a deep breath in through your nose... and slowly exhale through your mouth.

## Progressive Muscle Relaxation
Starting with your toes, begin to tense and then release each muscle group...

## Breathing Techniques
Focus on your breath as it flows naturally in and out...

## Visualization
Imagine yourself in a peaceful meadow, surrounded by gentle sounds of nature...

## Deepening
With each breath, you're becoming more and more relaxed...

## Suggestions for Stress Relief
Your mind is learning new ways to handle stress with calm confidence...

## Emergence
In a moment, I'll count from 1 to 5, and you'll return feeling refreshed and peaceful...`
    }
  }

  async *generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    // Starting mock generation

    // Log examples usage (in real implementation, examples would influence content generation)
    if (examples && examples.length > 0) {
      console.debug(`Using ${examples.length} examples to inform generation:`, examples.map(e => e.metadata?.filename || 'unknown'))
    }

    // Simulate initial API processing delay
    await this.delay(500, 1500, 'Initial API processing')
    
    // Check for abort after initial delay
    if (abortSignal?.aborted) {
      console.debug('Mock generation aborted after initial delay')
      return
    }

    // Regular generation - use prompt from request or extract from messages
    const prompt = request.prompt || (messages && messages.length > 0 
      ? messages[messages.length - 1]?.content || 'Generate a hypnosis script'
      : 'Generate a hypnosis script')
    const content = this.generateScriptContent(prompt)

    const formatSize = (bytes: number) => bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(2)}MB`
    console.debug('Content prepared', {
      contentSize: formatSize(content.length)
    })

    // Split into realistic chunks
    const chunks = this.splitIntoRealisticChunks(content)
    console.debug(`Split into ${chunks.length} chunks`)
    
    // Stream chunks with realistic delays
    for (let i = 0; i < chunks.length; i++) {
      // Check for abort before each chunk
      if (abortSignal?.aborted) {
        console.debug('Mock generation aborted during streaming')
        return
      }
      
      const chunk = chunks[i]
      // Progress tracking removed - handled at API service layer
      
      yield chunk
      
      // Variable delays between chunks to simulate real streaming
      if (i < chunks.length - 1) {
        if (Math.random() < 0.05) {
          // Occasional network delay (5% chance)
          await this.delay(10, 100, 'Network delay simulation')
        } else if (Math.random() < 0.2) {
          // Slower chunk (20% chance)
          await this.delay(10, 30)
        } else {
          // Normal speed - very fast for word-by-word streaming
          await this.delay(5, 20)
        }
        
        // Check for abort after delay
        if (abortSignal?.aborted) {
          console.debug('Mock generation aborted during streaming')
          return
        }
      }
    }

    // Streaming complete
  }

  async *regenerateSection(
    request: RegenerationRequest,
    _messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    console.debug('Mock regenerateSection called', { sectionTitle: request.sectionTitle })

    // Simulate initial API processing delay
    await this.delay(500, 1500, 'Section regeneration processing')
    
    // Check for abort after initial delay
    if (abortSignal?.aborted) {
      console.debug('Mock section regeneration aborted after initial delay')
      return
    }

    // Generate expanded content for the specific section
    const content = this.generateExpandedSectionContent(request.sectionTitle)
    const wordCount = content.split(/\s+/).length
    
    console.debug('Generated section regeneration content', {
      sectionTitle: request.sectionTitle,
      wordCount,
      meetsRequirement: wordCount >= 400
    })

    // Stream the regenerated content
    const chunks = this.splitIntoRealisticChunks(content)
    console.debug('Starting regeneration streaming', { totalChunks: chunks.length })

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      yield chunk
      
      // Variable delays for realistic streaming
      if (i < chunks.length - 1) {
        if (Math.random() < 0.05) {
          await this.delay(10, 100, 'Network delay simulation')
        } else if (Math.random() < 0.2) {
          await this.delay(10, 30)
        } else {
          await this.delay(5, 20)
        }
        
        // Check for abort after delay
        if (abortSignal?.aborted) {
          console.debug('Mock section regeneration aborted during streaming')
          return
        }
      }
    }

    console.debug('Section regeneration streaming complete')
  }
}