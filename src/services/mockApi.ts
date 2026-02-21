import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { ScriptGenerationService } from './scriptGenerationService'

export class MockAPIService implements ScriptGenerationService {
  constructor() {
    console.warn('MockAPIService is being used - this should only be used for testing!')
  }

  private async delay(min: number, max?: number): Promise<void> {
    const ms = max ? Math.random() * (max - min) + min : min
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private splitIntoRealisticChunks(content: string): string[] {
    const chunks: string[] = []
    const tokens = content.match(/\S+|\s+|\n/g) || []

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const rand = Math.random()

      if (rand < 0.15) {
        for (const char of token) {
          chunks.push(char)
        }
      } else if (rand < 0.8) {
        chunks.push(token)
      } else {
        let group = token
        const numToGroup = Math.floor(Math.random() * 3) + 1
        for (let j = 1; j <= numToGroup && i + j < tokens.length; j++) {
          group += tokens[i + j]
        }
        chunks.push(group)
        i += numToGroup
      }
    }

    return chunks
  }

  private async *streamContent(
    content: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const chunks = this.splitIntoRealisticChunks(content)

    for (let i = 0; i < chunks.length; i++) {
      if (abortSignal?.aborted) return

      yield chunks[i]

      if (i < chunks.length - 1) {
        if (Math.random() < 0.05) {
          await this.delay(10, 100)
        } else if (Math.random() < 0.2) {
          await this.delay(10, 30)
        } else {
          await this.delay(5, 20)
        }
        if (abortSignal?.aborted) return
      }
    }
  }

  private generateOutlineContent(prompt: string): string {
    if (prompt.toLowerCase().includes('confidence') || prompt.toLowerCase().includes('speaking')) {
      return `# Confidence and Inner Power
## Induction and Breath
Guide the listener into relaxation through focused breathing and attention on the voice.
## Deepening the Trance
Take the listener deeper using countdown and body awareness techniques.
## Building Confidence
Implant suggestions of natural confidence and self-assurance growing stronger.
## Anchoring the Change
Create a physical and mental anchor that triggers confidence on demand.
## Awakening
Gently bring the listener back carrying their new confidence with them.`
    }

    if (prompt.toLowerCase().includes('sleep') || prompt.toLowerCase().includes('insomnia')) {
      return `# Drift Into Deep Sleep
## Evening Wind-Down
Guide the listener to release the day and prepare the body for rest.
## Breath and Body Release
Use breath counting and progressive relaxation to quiet the nervous system.
## Mind Clearing
Help thoughts dissolve and the inner voice grow quiet and distant.
## Sleep Threshold
Guide the listener across the boundary between waking and sleeping.
## Deep Rest Suggestions
Embed suggestions for remaining asleep and waking refreshed.`
    }

    return `# Deep Relaxation and Renewal
## Induction
Guide the listener into a comfortable trance state through breathing and voice focus.
## Deepening
Use countdown and body scan techniques to deepen the relaxation state.
## Transformation
Introduce suggestions for letting go of tension and embracing calm renewal.
## Integration
Weave the new feelings of peace and clarity into the listener's sense of self.
## Awakening
Gently return the listener to full awareness carrying a sense of deep refreshment.`
  }

  private generateSectionContent(sectionTitle: string): string {
    // Each mock section generates ~400 words of content (no ## header, orchestrator adds it)
    const sectionContents: Record<string, string> = {
      'Induction': `Close your eyes now... and take a slow, deep breath in through your nose... hold it for just a moment... and let it go, slowly, through your mouth. Good. And again... breathe in, feeling your chest expand, your shoulders lift just slightly... and exhale, letting everything soften. Already you can feel something shifting, something settling inside you.

Focus now on the sound of my voice. Let it become the only thing that matters in this moment. Everything else... the sounds around you, the thoughts drifting through your mind... they can fade into the background, becoming distant and unimportant. My voice is here, steady and close, guiding you exactly where you need to go.

With each breath you take, you sink a little deeper into this comfortable state. Your body knows how to do this. It remembers how to let go, how to release, how to simply be still. You do not need to try. You do not need to force anything. Just breathe... and follow.

Notice the weight of your body against whatever is supporting you right now. Feel how gravity holds you, gently pulling you down, anchoring you in this moment. Your muscles begin to unwind on their own... the tension in your jaw loosening... your shoulders dropping away from your ears... your hands growing heavy and warm.

Each time you breathe out, imagine you are breathing out a thin grey mist... all the stress, all the noise, all the things you have been carrying... leaving you with each exhale. And each time you breathe in, you draw in a soft, warm light that fills you from the inside, spreading comfort through every part of you.

You are doing so well. Already you are more relaxed than you were just moments ago. And with every word I speak, with every breath you take, this feeling grows stronger, deeper, more complete. There is nowhere you need to be except right here. Nothing you need to do except listen... and breathe... and let yourself drift.`,

      'Induction and Breath': `Close your eyes now... and take a slow, deep breath in through your nose... hold it for just a moment... and let it go, slowly, through your mouth. Good. And again... breathe in, feeling your chest expand, your shoulders lift just slightly... and exhale, letting everything soften. Already you can feel something shifting, something settling inside you.

Focus now on the sound of my voice. Let it become the only thing that matters in this moment. Everything else... the sounds around you, the thoughts drifting through your mind... they can fade into the background, becoming distant and unimportant. My voice is here, steady and close, guiding you exactly where you need to go.

With each breath you take, you sink a little deeper into this comfortable state. Your body knows how to do this. It remembers how to let go, how to release, how to simply be still. You do not need to try. You do not need to force anything. Just breathe... and follow.

Notice the weight of your body against whatever is supporting you right now. Feel how gravity holds you, gently pulling you down, anchoring you in this moment. Your muscles begin to unwind on their own... the tension in your jaw loosening... your shoulders dropping away from your ears... your hands growing heavy and warm.

Each time you breathe out, imagine you are breathing out a thin grey mist... all the stress, all the noise, all the things you have been carrying... leaving you with each exhale. And each time you breathe in, you draw in a soft, warm light that fills you from the inside, spreading comfort through every part of you.

You are doing so well. Already you are more relaxed than you were just moments ago. And with every word I speak, with every breath you take, this feeling grows stronger, deeper, more complete. There is nowhere you need to be except right here. Nothing you need to do except listen... and breathe... and let yourself drift.`,
    }

    // Check if we have specific content for this section title
    if (sectionContents[sectionTitle]) {
      return sectionContents[sectionTitle]
    }

    // Generate generic ~400 word section content for any title
    return `Take a deep breath now and allow yourself to settle even more completely into this experience. With each word you hear, your attention narrows, your focus sharpens on my voice alone, and everything else becomes distant and unimportant. You are exactly where you need to be.

Feel the gentle rhythm of your breathing... in... and out... each cycle carrying you further along this path. Your body responds automatically now, releasing tension you did not even know you were holding. The muscles in your face soften. Your jaw unclenches. Your shoulders melt downward. Even your fingers and toes seem to grow heavier, warmer, more relaxed.

⏤

In this place of deep stillness, your mind becomes wonderfully receptive. Suggestions flow in easily, naturally, like water finding its way downhill. You do not need to analyse or resist. Simply allow the words to wash over you, knowing that your deeper mind is absorbing exactly what it needs.

Notice how good it feels to simply surrender to this process... to let go of control and allow yourself to be guided. Each time you return to this state, you find it easier, faster, more natural. The sound of my voice becomes a key that unlocks this doorway instantly. You are training your mind to respond, to follow, to go deeper with less and less effort.

⏤

Your breathing has found its own perfect rhythm now. Slow and steady. Effortless. With each exhale, you release a little more... a little more tension, a little more resistance, a little more of the everyday noise that usually fills your mind. And with each inhale, you draw in calm, clarity, and a growing sense of peaceful surrender.

This feeling is becoming familiar to you now. Comfortable. Safe. Deeply pleasurable. Your subconscious mind recognises this state and welcomes it, opening itself to positive change and growth. The work happening beneath the surface is profound and lasting, even if you are not consciously aware of all of it.

Continue to breathe... continue to follow... continue to let go. Everything is unfolding exactly as it should. You are doing beautifully, and with each passing moment, you sink deeper and deeper into this wonderful state of receptive calm.`
  }

  async *generateScript(
    request: GenerationRequest,
    _messages?: ChatMessage[],
    _examples?: ExampleScript[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    await this.delay(500, 1500)
    if (abortSignal?.aborted) return

    // The orchestrator now sends outline requests via generateScript
    // Detect if this is an outline request by checking prompt content
    const content = this.generateOutlineContent(request.prompt)
    yield* this.streamContent(content, abortSignal)
  }

  async *regenerateSection(
    request: RegenerationRequest,
    _messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    await this.delay(300, 800)
    if (abortSignal?.aborted) return

    // Generate ~400 word section content (no header - orchestrator adds ## Title)
    const content = this.generateSectionContent(request.sectionTitle)
    yield* this.streamContent(content, abortSignal)
  }
}
