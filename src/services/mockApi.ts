import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { ScriptGenerationService } from './scriptGenerationService'
import { STYLE_REVIEW_SECTION_TITLE } from './critiquePass'
import { OUTLINE_CRITIQUE_SECTION_TITLE } from './outlineCritique'
import { SCRIPT_REVIEW_SECTION_TITLE } from './scriptReview'
import { BRIEF_QUESTIONS_SECTION_TITLE } from './briefQuestions'
import { SECTION_TARGET_WORDS } from './sectionQuality'
import { countWords } from '../utils/scriptMetrics'
import { beginTranscript, exampleIdsOf } from './debugTranscript'
import type { TranscriptMessage } from './debugTranscript'

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

  // Mock sections are padded up to the same word target real generation aims
  // for, so a mock run does not trip the section-quality retry on every
  // section
  private padToSectionTarget(content: string): string {
    const filler = [
      `And still your breathing carries you… slower now… deeper now… each cycle loosening something you have been holding without noticing. There is no effort in this. The rhythm does the work, and you simply travel with it, further from the surface with every quiet exhale.`,
      `Notice how readily you follow… how natural it has become to let the next suggestion arrive and settle. Each time you respond, responding grows easier, until following feels less like a choice and more like the shape of this moment.`,
      `My voice stays close, steady, unhurried… a thread you can follow without thinking about following it. Everything outside it thins out, grows distant, and matters less than it did a moment ago. Here there is only the voice, the breath, and the drift.`
    ]

    let padded = content
    let index = 0
    while (countWords(padded) < SECTION_TARGET_WORDS) {
      padded += `\n\n${filler[index % filler.length]}`
      index++
    }
    return padded
  }

  private generateSectionContent(sectionTitle: string): string {
    // Each mock section generates ~400 words of content, padded to the section
    // target below (no ## header, the orchestrator adds it)
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
      return this.padToSectionTarget(sectionContents[sectionTitle])
    }

    // Generate generic section content for any title
    return this.padToSectionTarget(`Take a deep breath now and allow yourself to settle even more completely into this experience. With each word you hear, your attention narrows, your focus sharpens on my voice alone, and everything else becomes distant and unimportant. You are exactly where you need to be.

Feel the gentle rhythm of your breathing... in... and out... each cycle carrying you further along this path. Your body responds automatically now, releasing tension you did not even know you were holding. The muscles in your face soften. Your jaw unclenches. Your shoulders melt downward. Even your fingers and toes seem to grow heavier, warmer, more relaxed.

⏤

In this place of deep stillness, your mind becomes wonderfully receptive. Suggestions flow in easily, naturally, like water finding its way downhill. You do not need to analyse or resist. Simply allow the words to wash over you, knowing that your deeper mind is absorbing exactly what it needs.

Notice how good it feels to simply surrender to this process... to let go of control and allow yourself to be guided. Each time you return to this state, you find it easier, faster, more natural. The sound of my voice becomes a key that unlocks this doorway instantly. You are training your mind to respond, to follow, to go deeper with less and less effort.

⏤

Your breathing has found its own perfect rhythm now. Slow and steady. Effortless. With each exhale, you release a little more... a little more tension, a little more resistance, a little more of the everyday noise that usually fills your mind. And with each inhale, you draw in calm, clarity, and a growing sense of peaceful surrender.

This feeling is becoming familiar to you now. Comfortable. Safe. Deeply pleasurable. Your subconscious mind recognises this state and welcomes it, opening itself to positive change and growth. The work happening beneath the surface is profound and lasting, even if you are not consciously aware of all of it.

Continue to breathe... continue to follow... continue to let go. Everything is unfolding exactly as it should. You are doing beautifully, and with each passing moment, you sink deeper and deeper into this wonderful state of receptive calm.`)
  }

  // Records the request the same way the real providers do, so the debug
  // transcript option can be exercised without an API key. The mock never
  // embeds example scripts, so only their ids are recorded.
  private async *streamRecorded(
    content: string,
    messages: TranscriptMessage[],
    label: string,
    abortSignal?: AbortSignal,
    exampleIds?: string[]
  ): AsyncGenerator<string, void, unknown> {
    const transcript = beginTranscript({
      provider: 'mock',
      model: 'mock',
      label,
      exampleIds,
      messages
    })

    for await (const chunk of this.streamContent(content, abortSignal)) {
      transcript.appendChunk(chunk)
      yield chunk
    }

    if (abortSignal?.aborted) {
      transcript.abort()
      return
    }
    transcript.complete()
  }

  async *generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    await this.delay(500, 1500)
    if (abortSignal?.aborted) return

    // The orchestrator now sends outline requests via generateScript
    // Detect if this is an outline request by checking prompt content
    const content = this.generateOutlineContent(request.prompt)
    const sent = messages && messages.length > 0
      ? messages
      : [{ role: 'user' as const, content: request.prompt }]
    yield* this.streamRecorded(
      content,
      sent,
      'Generation',
      abortSignal,
      exampleIdsOf(examples)
    )
  }

  private extractSectionTitles(messages: ChatMessage[]): string[] {
    const titles: string[] = []
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const line of message.content.split('\n')) {
        const match = line.match(/^##\s+(.+?)\s*$/)
        if (match && !titles.includes(match[1])) {
          titles.push(match[1])
        }
      }
    }
    return titles
  }

  private generateRefinedSectionContent(): string {
    return `Let everything slow down now... even more than before. Feel how each breath arrives on its own, unhurried, complete. There is nothing to reach for here... nothing to hold. Only this soft, patient rhythm carrying you along, the way a slow river carries a leaf.

Notice the quiet spreading through you. It begins somewhere behind your eyes... drifts down through your jaw... your throat... your chest. Every place it touches grows heavier, warmer, more at ease. You are settling, layer by layer, into a stillness that feels familiar now... as though your body has been waiting all day for permission to rest this deeply.

⏤

And in this stillness, the words you hear sink further than they did before. They do not need your attention to work. They move beneath thought, beneath effort, finding the places that are ready to change. You can simply listen... or not listen... and either way the change continues, gentle and certain.

Feel how good it is to be carried like this. To trust the process. To let each suggestion settle where it belongs, the way snow settles on a quiet field... evenly, softly, without a single sound. Whatever brought you here is being tended to now, in this deeper, slower way.

⏤

Breathe in... and feel the calm gather. Breathe out... and feel it spread. Each cycle smooths another edge, loosens another knot, opens another door. You are further along than you realise, and every moment takes you further still.

There is no hurry. There was never any hurry. The pace is yours, and the pace is perfect. Simply continue... breathing... listening... drifting... while everything you came here for unfolds exactly as it should, at exactly the depth you need.`
  }

  private generateRefinementContent(messages: ChatMessage[]): string {
    // A refinement rewrites only the sections that change: pick up to two
    // known section titles from the conversation and rewrite those
    const titles = this.extractSectionTitles(messages).slice(0, 2)
    if (titles.length === 0) {
      return `## Refined Section\n\n${this.generateRefinedSectionContent()}`
    }

    return titles
      .map(title => `## ${title}\n\n${this.generateRefinedSectionContent()}`)
      .join('\n\n')
  }

  // A plausible style-critique response (story 8.5): one VERDICT line per
  // section of the script under review, with a couple of violations so the
  // revision flow can be exercised, plus a stray commentary line the parser
  // must skip
  private generateCritiqueContent(prompt: string): string {
    // Only parse "##" headings after the review marker so the style-rules
    // heading in the prompt itself is not mistaken for a script section
    const marker = 'Here is the script to review:'
    const markerIndex = prompt.indexOf(marker)
    const scriptText = markerIndex >= 0 ? prompt.slice(markerIndex + marker.length) : prompt

    const titles: string[] = []
    for (const line of scriptText.split('\n')) {
      const match = line.match(/^##\s+(.+?)\s*$/)
      if (match && !titles.includes(match[1])) {
        titles.push(match[1])
      }
    }

    if (titles.length === 0) {
      return 'VERDICT: Script | compliant'
    }

    const violations = new Map<string, { rules: number[]; reason: string }>()
    if (titles.length > 1) {
      violations.set(titles[1], {
        rules: [6],
        reason: 'Leans on a cliched nature visualisation instead of voice and breath.'
      })
    }
    if (titles.length > 2) {
      violations.set(titles[titles.length - 1], {
        rules: [9],
        reason: 'Uses negations ("do not resist") instead of affirmative phrasing.'
      })
    }

    const verdictLines = titles.map(title => {
      const violation = violations.get(title)
      return violation
        ? `VERDICT: ${title} | violates ${violation.rules.join(', ')} | ${violation.reason}`
        : `VERDICT: ${title} | compliant`
    })

    return ['Here is my review of the script:', ...verdictLines].join('\n')
  }

  // A plausible whole-script review response (story 8.14): one verdict line
  // per section, flagging the middle section for a continuity break so the
  // rewrite flow is exercised
  private generateScriptReviewContent(prompt: string): string {
    const titles = this.extractReviewedSectionTitles(prompt)
    if (titles.length === 0) return 'VERDICT: Script | cohesive'

    const flagged = titles[Math.floor(titles.length / 2)]

    return [
      'Here is my review of the script as a whole:',
      ...titles.map(title =>
        title === flagged
          ? `VERDICT: ${title} | revise | Re-inducts a listener who is already deep and repeats the ` +
            'breathing imagery of the section before it; carry the depth forward and escalate instead.'
          : `VERDICT: ${title} | cohesive`
      )
    ].join('\n')
  }

  // Only "##" headings after the review marker are script sections; headings
  // in the prompt's own instructions are not
  private extractReviewedSectionTitles(prompt: string): string[] {
    const marker = 'Here is the script to review:'
    const markerIndex = prompt.indexOf(marker)
    const scriptText = markerIndex >= 0 ? prompt.slice(markerIndex + marker.length) : prompt

    const titles: string[] = []
    for (const line of scriptText.split('\n')) {
      const match = line.match(/^##\s+(.+?)\s*$/)
      if (match && !titles.includes(match[1])) {
        titles.push(match[1])
      }
    }
    return titles
  }

  // A plausible outline-critique response (story 8.9): the mock always finds
  // the escalation arc lacking and returns the outline with the second
  // section's description revised, exercising the replacement flow. A
  // prompt without a recognisable outline is approved unchanged.
  private generateOutlineCritiqueContent(prompt: string): string {
    const marker = 'Here is the outline to review:'
    const markerIndex = prompt.indexOf(marker)
    if (markerIndex < 0) return 'OUTLINE OK'

    const outlineText = prompt.slice(markerIndex + marker.length).trim()
    const lines = outlineText.split('\n')

    let sectionCount = 0
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        sectionCount++
        if (sectionCount === 2 && i + 1 < lines.length) {
          lines[i + 1] =
            "Deepen the listener's trance while gradually escalating intensity toward the transformation ahead."
          return lines.join('\n')
        }
      }
    }

    return 'OUTLINE OK'
  }

  // A plausible briefing questionnaire (story 1.10), in the line format the
  // parser expects, so the stage can be exercised without a provider. The
  // first question picks up the brief's own words, so the mock at least looks
  // like it read it.
  private generateBriefQuestionsContent(prompt: string): string {
    const marker = 'The brief:'
    const markerIndex = prompt.lastIndexOf(marker)
    const brief = (markerIndex >= 0 ? prompt.slice(markerIndex + marker.length) : prompt).trim()
    const subject = brief.split(/\s+/).slice(0, 6).join(' ') || 'the brief'

    return [
      `Q: How direct should "${subject}" be at the start?`,
      '- Slow and oblique | Nothing named until the listener is deep',
      '- Plain from the first minute | The intent is stated up front',
      '- Escalating in steps | Each section names a little more',
      '',
      'Q: What trigger should the script plant?',
      '- "Sink" | One word drops them straight back down',
      '- "Eyes on me" | A phrase the hypnotist says aloud',
      '- A snap of the fingers | A sound rather than a word',
      '',
      'Q: What should still be working tomorrow? (choose any that apply)',
      '- The voice pulls them back | Each listen drops them faster',
      '- Arousal returns on the trigger | The body answers before the mind',
      '- Obedience carries into the day | Following stays easy once they wake'
    ].join('\n')
  }

  async *regenerateSection(
    request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    await this.delay(300, 800)
    if (abortSignal?.aborted) return

    // The style-review marker asks for a critique of the submitted script.
    // An empty section title marks a whole-script refinement: respond with
    // full "## Section" blocks for the sections that change.
    // Otherwise generate ~400 word section content (no header - orchestrator adds ## Title)
    const content = request.sectionTitle === STYLE_REVIEW_SECTION_TITLE
      ? this.generateCritiqueContent(request.prompt)
      : request.sectionTitle === SCRIPT_REVIEW_SECTION_TITLE
        ? this.generateScriptReviewContent(request.prompt)
        : request.sectionTitle === OUTLINE_CRITIQUE_SECTION_TITLE
          ? this.generateOutlineCritiqueContent(request.prompt)
          : request.sectionTitle === BRIEF_QUESTIONS_SECTION_TITLE
            ? this.generateBriefQuestionsContent(request.prompt)
            : request.sectionTitle === ''
              ? this.generateRefinementContent(messages)
              : this.generateSectionContent(request.sectionTitle)
    yield* this.streamRecorded(
      content,
      messages,
      request.sectionTitle || 'Refinement',
      abortSignal
    )
  }
}
