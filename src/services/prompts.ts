import hypnosisSystemPrompt from '../prompts/hypnosis-system.txt?raw'
import sectionRegenerationPrompt from '../prompts/section-regeneration.txt?raw'

export class PromptService {
  static getSystemPrompt(): string {
    return hypnosisSystemPrompt
  }

  static getSectionRegenerationPrompt(sectionTitle: string): string {
    return sectionRegenerationPrompt.replace('{sectionTitle}', sectionTitle)
  }
}