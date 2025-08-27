import type { ExampleScript } from './vectorStore'
import type { ExampleSearchService } from './exampleSearchService'
import { CONTEXT_LIMITS } from '../utils/contextWindow'

export class MockVectorStoreService implements ExampleSearchService {
  private mockExamples: ExampleScript[] = [
    {
      content: `# Confidence Building Script

## Introduction
Welcome to this confidence-building session. Take a moment to settle into a comfortable position.

## Induction
Close your eyes and take three deep, calming breaths. With each exhale, allow yourself to relax more deeply.

## Building Self-Assurance
You are naturally confident and capable. Your inner strength grows with each passing moment.

## Visualization of Success
See yourself moving through your day with quiet confidence and self-assurance.

## Positive Affirmations
You trust in your abilities and make decisions with clarity and wisdom.

## Emergence
When you're ready, gently return to full awareness, carrying this confidence with you.`,
      metadata: { filename: 'confidence-building.md', category: 'self-improvement' }
    },
    {
      content: `# Deep Relaxation for Sleep

## Preparation
Find a comfortable position in your bed, allowing your body to fully settle.

## Progressive Relaxation
Starting with your toes, release all tension as you prepare for restful sleep.

## Breathing for Sleep
Your breath naturally slows and deepens, guiding you toward peaceful slumber.

## Mental Clearing
Like gentle waves, let all thoughts of the day drift peacefully away.

## Sleep Induction
Your mind and body know exactly how to achieve deep, restorative sleep.

## Dream Suggestions
Tonight you sleep deeply and wake feeling refreshed and energized.`,
      metadata: { filename: 'deep-sleep.md', category: 'sleep' }
    },
    {
      content: `# Stress Relief and Calm

## Centering
Take a moment to connect with your inner sense of calm and peace.

## Tension Release
Notice any areas of tension in your body and gently release them.

## Peaceful Imagery
Imagine yourself in a serene natural setting where you feel completely at ease.

## Stress Transformation
Your mind learns new ways to respond to challenges with calm confidence.

## Inner Resources
You have access to an unlimited source of peace and tranquility within you.

## Integration
This sense of calm stays with you throughout your day.`,
      metadata: { filename: 'stress-relief.md', category: 'relaxation' }
    },
    {
      content: `# Public Speaking Confidence

## Foundation Building
Your natural ability to communicate clearly and effectively is awakening.

## Overcoming Nervousness
Any nervousness transforms into positive energy that enhances your presentation.

## Audience Connection
You feel a genuine connection with your audience, speaking from the heart.

## Clear Communication
Your words flow naturally and your message is received with understanding.

## Confidence Anchoring
Each speaking opportunity strengthens your confidence and skill.

## Future Success
You look forward to sharing your voice and message with others.`,
      metadata: { filename: 'public-speaking.md', category: 'confidence' }
    },
    {
      content: `# Pain Management and Comfort

## Comfort Positioning
Allow your body to find the most comfortable position possible.

## Awareness and Acceptance
Acknowledge any discomfort without judgment, simply observing.

## Healing Visualization
Imagine warm, healing light flowing to areas that need comfort.

## Mind-Body Connection
Your mind has powerful influence over your physical comfort and well-being.

## Natural Healing
Your body's natural healing mechanisms are enhanced and supported.

## Ongoing Comfort
You carry this sense of ease and comfort with you throughout your day.`,
      metadata: { filename: 'pain-management.md', category: 'healing' }
    }
  ]

  /**
   * Mock search for relevant example scripts
   * @param query User's prompt/query  
   * @param limit Maximum number of examples to retrieve
   * @returns Array of relevant example scripts
   */
  async searchExamples(query: string, limit: number = CONTEXT_LIMITS.DEFAULT_EXAMPLES): Promise<ExampleScript[]> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300))

    // Simple keyword matching for demo purposes
    const lowerQuery = query.toLowerCase()
    const scored = this.mockExamples.map(example => {
      let score = 0
      const content = example.content.toLowerCase()
      const metadata = example.metadata as Record<string, string>

      // Score based on keyword matches
      if (lowerQuery.includes('confidence') && (content.includes('confidence') || metadata.category === 'confidence')) {
        score += 10
      }
      if (lowerQuery.includes('sleep') && (content.includes('sleep') || metadata.category === 'sleep')) {
        score += 10
      }
      if (lowerQuery.includes('stress') && (content.includes('stress') || metadata.category === 'relaxation')) {
        score += 10
      }
      if (lowerQuery.includes('speak') && content.includes('speak')) {
        score += 10
      }
      if (lowerQuery.includes('pain') && content.includes('pain')) {
        score += 10
      }
      if (lowerQuery.includes('relax') && (content.includes('relax') || metadata.category === 'relaxation')) {
        score += 8
      }

      // General relevance scoring
      const queryWords = lowerQuery.split(' ').filter(word => word.length > 2)
      queryWords.forEach(word => {
        if (content.includes(word)) {
          score += 2
        }
      })

      return { ...example, score }
    })

    // Sort by score and return top results
    return scored
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit)
  }

  /**
   * Get all available examples (for testing/debugging)
   */
  async getAllExamples(): Promise<ExampleScript[]> {
    return this.mockExamples
  }
}