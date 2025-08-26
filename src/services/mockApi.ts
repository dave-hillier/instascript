import type { GenerationRequest, Conversation } from '../types/conversation'
import type { ExampleScript } from './vectorStore'
import { Logger } from '../utils/logger'

export class MockAPIService {
  private async delay(min: number, max?: number, reason?: string): Promise<void> {
    const ms = max ? Math.random() * (max - min) + min : min
    if (reason) {
      Logger.log('MockAPI', `${reason} (${ms.toFixed(0)}ms)`)
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private splitIntoRealisticChunks(content: string): string[] {
    const chunks: string[] = []
    
    // Split by sentences first
    const sentences = content.match(/[^.!?]+[.!?]+\s*/g) || []
    
    // Group sentences into chunks of varying sizes to simulate streaming
    let currentChunk = ''
    
    for (const sentence of sentences) {
      // Randomly decide whether to send this sentence alone or group it
      const shouldGroup = Math.random() > 0.3
      
      if (shouldGroup && currentChunk) {
        currentChunk += sentence
        // Send chunk if it's getting long
        if (currentChunk.length > 150 || Math.random() > 0.7) {
          chunks.push(currentChunk)
          currentChunk = ''
        }
      } else if (currentChunk) {
        chunks.push(currentChunk)
        currentChunk = sentence
      } else {
        currentChunk = sentence
      }
    }
    
    // Push any remaining content
    if (currentChunk) {
      chunks.push(currentChunk)
    }
    
    return chunks
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
    conversation?: Conversation,
    examples?: ExampleScript[]
  ): AsyncGenerator<string, void, unknown> {
    Logger.group('MockAPI Generation')
    Logger.log('MockAPI', 'Starting mock generation', {
      prompt: request.prompt.substring(0, 50) + '...',
      hasExamples: examples && examples.length > 0,
      regenerate: request.regenerate
    })

    // Log examples usage (in real implementation, examples would influence content generation)
    if (examples && examples.length > 0) {
      Logger.log('MockAPI', `Using ${examples.length} example(s) to inform generation`)
    }

    // Simulate initial API processing delay
    await this.delay(1000, 2500, 'Initial API processing')

    // Get the appropriate content based on the request
    let content: string
    
    if (request.regenerate && request.sectionId && conversation) {
      const section = conversation.sections.find(s => s.id === request.sectionId)
      if (section) {
        Logger.log('MockAPI', 'Regenerating section', { sectionId: request.sectionId })
        // For regeneration, return a modified version of the section
        content = section.content.replace(/\.\.\./g, '... [refreshed content] ...')
      } else {
        content = this.generateScriptContent(request.prompt)
      }
    } else {
      content = this.generateScriptContent(request.prompt)
    }

    Logger.log('MockAPI', 'Content prepared', {
      contentSize: Logger.formatSize(content.length)
    })

    // Split into realistic chunks
    const chunks = this.splitIntoRealisticChunks(content)
    Logger.log('MockAPI', `Split into ${chunks.length} chunks`)
    
    // Stream chunks with realistic delays
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const progress = ((i + 1) / chunks.length * 100).toFixed(1)
      
      // Log progress every 25%
      if (i === 0 || (i + 1) % Math.ceil(chunks.length / 4) === 0) {
        Logger.log('MockAPI', `Streaming progress: ${progress}%`)
      }
      
      yield chunk
      
      // Variable delays between chunks
      if (i < chunks.length - 1) {
        if (Math.random() < 0.1) {
          // Occasional network delay (10% chance)
          await this.delay(300, 800, 'Network delay simulation')
        } else if (Math.random() < 0.3) {
          // Slower chunk (30% chance)
          await this.delay(100, 300)
        } else {
          // Normal speed
          await this.delay(30, 100)
        }
      }
    }

    Logger.log('MockAPI', 'Streaming complete')
    Logger.groupEnd()
  }
}