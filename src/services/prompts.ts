import hypnosisSystemPrompt from '../prompts/hypnosis-system.txt?raw'
import sectionRegenerationPrompt from '../prompts/section-regeneration.txt?raw'
import outlineGenerationPrompt from '../prompts/outline-generation.txt?raw'
import sectionGenerationPrompt from '../prompts/section-generation.txt?raw'
import scriptRefinementPrompt from '../prompts/script-refinement.txt?raw'
import styleCritiquePrompt from '../prompts/style-critique.txt?raw'
import outlineCritiquePrompt from '../prompts/outline-critique.txt?raw'
import scriptReviewPrompt from '../prompts/script-review.txt?raw'
import briefQuestionsPrompt from '../prompts/brief-questions.txt?raw'
import exampleTaggingPrompt from '../prompts/example-tagging.txt?raw'
import importFormattingPrompt from '../prompts/import-formatting.txt?raw'
import directAddressPrompt from '../prompts/direct-address.txt?raw'
import type { ExampleScript } from './exampleSearchService'
import type { RawConversation, ChatMessage, OutlineSection } from '../types/conversation'
import { getLatestOutline, consolidateSections } from './conversationDocument'
import { SECTION_TARGET_WORDS } from './sectionQuality'
import { buildLengthPlan } from './scriptLength'
import type { LengthPlan } from './scriptLength'
import type { DocumentSection } from './conversationDocument'
import type { ScriptFsTree } from './scriptFs'
import { exampleLabel, mountExamples, renderScriptFsTree } from './scriptFs'
import { getJobInstructions } from './config'

/**
 * Prompt generation. Pure apart from the standing instructions below, which
 * are read from settings as each prompt is built.
 */

const CONTINUITY_EXCERPT_WORDS = 75

// --- Standing instructions (story 5.9) -----------------------------------
// The one thing here that is not derived from its arguments: two free-text
// settings the user writes once and every request for the job they name
// carries. They are appended as a block at the very end of the prompt they
// apply to — last position, where an instruction carries most weight, and
// after every placeholder has already been substituted, so a brace-shaped
// phrase in the user's own words is never mistaken for a placeholder.
//
// An unset field appends nothing at all, so the prompts stay byte-identical
// to the ones the app ships with — including the cached system-prompt prefix
// (docs/prompt-caching.md), which changes only when the setting changes.

const STANDING_INSTRUCTIONS_HEADING = '## Standing instructions'

const STYLE_INSTRUCTIONS_PREAMBLE =
  'These are the user\'s standing instructions for every script written for ' +
  'them. Follow them throughout. Where they differ from the general guidance ' +
  'above, follow these; they do not change the output format asked for.'

const IMPORT_INSTRUCTIONS_PREAMBLE =
  'These are the user\'s standing instructions for material coming into their ' +
  'library. Follow them where they do not conflict with the rules above; where ' +
  'they do, the rules above win.'

// Pure: the prompt with an instruction block appended, or the prompt exactly
// as it was when there is nothing to say
export function appendStandingInstructions(
  prompt: string,
  instructions: string,
  preamble: string
): string {
  const trimmed = instructions.trim()
  if (!trimmed) return prompt
  return `${prompt}\n\n${STANDING_INSTRUCTIONS_HEADING}\n\n${preamble}\n\n${trimmed}`
}

// The style instructions reach generation through the system prompt, so every
// request that writes prose carries them, and through the critique that
// judges the result — the pass has to hold the script to the same standing
// instructions it was written against.
function withStyleInstructions(prompt: string): string {
  return appendStandingInstructions(
    prompt,
    getJobInstructions('style'),
    STYLE_INSTRUCTIONS_PREAMBLE
  )
}

// The import instructions reach each of the utility jobs that run over an
// imported example. The faithfulness checks in importAssist are unchanged:
// an instruction that talks a small model into rewriting a script still ends
// with the rewrite discarded and the import kept as it arrived.
function withImportInstructions(prompt: string): string {
  return appendStandingInstructions(
    prompt,
    getJobInstructions('import'),
    IMPORT_INSTRUCTIONS_PREAMBLE
  )
}

// The requested length reaches the model through the three prompts that decide
// how much script gets written: the system prompt states the whole-script aim,
// the outline prompt turns it into a section count, and the outline critique
// judges — and may rewrite — the plan against the same numbers.
function applyLengthPlan(template: string, plan: LengthPlan): string {
  return template
    .replace(/\{targetMinutes\}/g, String(plan.targetMinutes))
    .replace(/\{totalWords\}/g, plan.totalWords.toLocaleString('en-US'))
    .replace(/\{minWords\}/g, plan.minWords.toLocaleString('en-US'))
    .replace(/\{maxWords\}/g, plan.maxWords.toLocaleString('en-US'))
    .replace(/\{sectionCount\}/g, String(plan.sectionCount))
    .replace(/\{sectionWords\}/g, String(plan.sectionWords))
}

export function getSystemPrompt(plan: LengthPlan = buildLengthPlan()): string {
  return withStyleInstructions(applyLengthPlan(hypnosisSystemPrompt, plan))
}

export function getOutlineGenerationPrompt(plan: LengthPlan = buildLengthPlan()): string {
  return applyLengthPlan(outlineGenerationPrompt, plan)
}

// The outline entries for the sections still to be written, phrased so the
// current section can plant setups for them (story 8.10). Empty for the
// final section.
export function formatUpcomingSections(upcomingSections: OutlineSection[]): string {
  if (upcomingSections.length === 0) return ''

  const entries = upcomingSections
    .map(section => `- "${section.title}": ${section.description}`)
    .join('\n')

  return '\nStill to come after this section (planned, not yet written):\n' +
    entries +
    '\nWhere it serves the arc, plant setups in this section that the upcoming sections can pay off. Do not write their content now.\n'
}

export function getSectionGenerationPrompt(
  sectionTitle: string,
  sectionDescription: string,
  upcomingSections: OutlineSection[] = []
): string {
  return sectionGenerationPrompt
    .replace('{sectionTitle}', sectionTitle)
    .replace('{sectionDescription}', sectionDescription)
    .replace('{upcomingSections}', () => formatUpcomingSections(upcomingSections))
    .replace('{targetWords}', String(SECTION_TARGET_WORDS))
}

function excerptStart(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(word => word.length > 0)
  if (words.length <= maxWords) return text.trim()
  return words.slice(0, maxWords).join(' ') + ' …'
}

function excerptEnd(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(word => word.length > 0)
  if (words.length <= maxWords) return text.trim()
  return '… ' + words.slice(-maxWords).join(' ')
}

// The script's current structure, rendered from the virtual filesystem
// projection. It is context, not instruction, and it goes at the very end of
// the last user turn: everything before that point is the cached prefix
// (docs/prompt-caching.md), and the tree changes with every generation.
export function buildStructureBlock(tree: ScriptFsTree): string {
  const examplesNote = tree.examples.length > 0
    ? ' Under /examples/ are the exemplar scripts quoted in full at the end of the ' +
      'system prompt, one directory each, listed with their tags; each is labelled ' +
      'there with the path it appears at here.'
    : ''

  return 'Current structure of the script:\n\n' +
    renderScriptFsTree(tree) +
    '\nEach section is a directory holding prompt.md (its spec, from the outline) and ' +
    'content.md (its written text). A section is "stale" when its spec changed after ' +
    'its text was written, "empty" when nothing has been written for it yet, and ' +
    '"fresh" otherwise. Word counts are of content.md.' + examplesNote +
    ' Use this to see where the ' +
    'section you are writing sits in the whole; do not restate it in your reply.'
}

// Appended last so the block never displaces a rendered prompt's own ending.
function appendStructureBlock(prompt: string, structure?: ScriptFsTree): string {
  if (!structure) return prompt
  return `${prompt}\n\n${buildStructureBlock(structure)}`
}

export interface SectionRegenerationContext {
  sectionTitle: string
  outlineDescription?: string
  previousSection?: DocumentSection
  nextSection?: DocumentSection
  instruction?: string
  // Optional; omitted entirely when absent, so existing call sites are byte-identical
  structure?: ScriptFsTree
}

// Outline-aware section regeneration: the section's outline entry supplies
// the spec, the surrounding sections supply continuity, and an optional
// user instruction directs the rewrite.
export function buildSectionRegenerationPrompt(context: SectionRegenerationContext): string {
  const description = context.outlineDescription?.trim()
    ? context.outlineDescription.trim()
    : 'consistent with its current role and position in the script'

  const continuityParts: string[] = []
  if (context.previousSection) {
    continuityParts.push(
      `The preceding section "${context.previousSection.title}" currently ends with:\n\n` +
      excerptEnd(context.previousSection.content, CONTINUITY_EXCERPT_WORDS)
    )
  }
  if (context.nextSection) {
    continuityParts.push(
      `The following section "${context.nextSection.title}" currently begins with:\n\n` +
      excerptStart(context.nextSection.content, CONTINUITY_EXCERPT_WORDS)
    )
  }
  const continuity = continuityParts.length > 0
    ? '\n' + continuityParts.join('\n\n') + '\n'
    : ''

  let prompt = sectionRegenerationPrompt
    .replace(/\{sectionTitle\}/g, context.sectionTitle)
    .replace('{sectionDescription}', description)
    .replace('{continuity}', continuity)
    .replace('{targetWords}', String(SECTION_TARGET_WORDS))

  const instruction = context.instruction?.trim()
  if (instruction) {
    prompt += `\n\nAdditional instruction from the user for this rewrite:\n${instruction}`
  }

  return appendStructureBlock(prompt, context.structure)
}

export function buildSectionRegenerationPromptFromConversation(
  conversation: RawConversation,
  sectionTitle: string,
  instruction?: string,
  structure?: ScriptFsTree
): string {
  const outline = getLatestOutline(conversation)
  const sections = consolidateSections(conversation)
  const index = sections.findIndex(section => section.title === sectionTitle)

  return buildSectionRegenerationPrompt({
    sectionTitle,
    outlineDescription: outline?.sections.find(section => section.title === sectionTitle)?.description,
    previousSection: index > 0 ? sections[index - 1] : undefined,
    nextSection: index >= 0 && index < sections.length - 1 ? sections[index + 1] : undefined,
    instruction,
    structure
  })
}

// The numbered style rules as written in hypnosis-system.txt — the single
// source of truth shared by generation and the style-review pass (story 8.5)
export function getStyleRules(): string {
  const index = hypnosisSystemPrompt.indexOf('## Style rules')
  return (index >= 0 ? hypnosisSystemPrompt.slice(index) : hypnosisSystemPrompt).trim()
}

// The critique request for the style-review pass: the consolidated script
// plus the system prompt's own style rules, asking for one strict
// line-oriented verdict per section
export function buildStyleCritiquePrompt(script: string): string {
  return styleCritiquePrompt
    .replace('{styleRules}', () => withStyleInstructions(getStyleRules()))
    .replace('{script}', () => script)
}

// The critique request for the outline-critique step (story 8.9): the user's
// brief plus the freshly generated outline, asking for either approval or a
// full revised outline in the same format. A revised outline is the plan every
// section inherits, so the critique is held to the same length plan the
// outline was generated against. Length substitution runs on the template
// first, so placeholder-shaped text in the brief or outline is never replaced.
export function buildOutlineCritiquePrompt(
  brief: string,
  outlineText: string,
  plan: LengthPlan = buildLengthPlan()
): string {
  return applyLengthPlan(outlineCritiquePrompt, plan)
    .replace('{brief}', () => brief)
    .replace('{outline}', () => outlineText)
}

// The review request for the on-demand whole-script review (story 8.14): the
// brief, the measured length against its spoken-duration target, and the
// consolidated script, asking for one verdict per section on how it sits in
// the arc
export function buildScriptReviewPrompt(
  brief: string,
  lengthBrief: string,
  script: string
): string {
  return scriptReviewPrompt
    .replace('{brief}', () => brief.trim() || 'No brief was recorded for this script.')
    .replace('{lengthBrief}', () => lengthBrief)
    .replace('{script}', () => script)
}

// The shape the briefing questionnaire is asked for (story 1.10). Held here
// with the template it fills in; the parser that reads the reply back is
// deliberately more forgiving than these numbers.
const BRIEF_QUESTION_COUNT = { min: 3, max: 5 }
const BRIEF_OPTION_COUNT = { min: 3, max: 4 }

// The questions request for the optional briefing stage: the user's brief and
// nothing else, asking for a short multiple-choice questionnaire about what
// the brief leaves open. Substitution runs on the template first, so
// placeholder-shaped text in the brief is never replaced.
export function buildBriefQuestionsPrompt(brief: string): string {
  return briefQuestionsPrompt
    .replace('{minQuestions}', String(BRIEF_QUESTION_COUNT.min))
    .replace('{maxQuestions}', String(BRIEF_QUESTION_COUNT.max))
    .replace('{minOptions}', String(BRIEF_OPTION_COUNT.min))
    .replace('{maxOptions}', String(BRIEF_OPTION_COUNT.max))
    .replace('{brief}', () => brief.trim())
}

// --- Utility-model prompts (story 5.7) ----------------------------------
// Short jobs handed to the small model configured for the utility role.

// Tags describe what a script is for, which its opening establishes; sending
// the whole script would multiply the cost of the cheapest job in the app for
// no gain in the tags.
export const TAGGING_EXCERPT_WORDS = 600

// The tags already in use are offered to the model so a growing corpus
// converges on one vocabulary instead of accumulating near-duplicates
export function buildExampleTaggingPrompt(knownTags: string[]): string {
  const known = knownTags.length > 0 ? knownTags.join(', ') : '(none yet)'
  return withImportInstructions(exampleTaggingPrompt.replace('{knownTags}', () => known))
}

export function buildTaggingInput(title: string, content: string): string {
  return `Title: ${title}\n\n${excerptStart(content, TAGGING_EXCERPT_WORDS)}`
}

// Typesetting only: the script's words must survive the pass untouched, which
// the caller verifies before storing the result
export function buildImportFormattingPrompt(title: string): string {
  return withImportInstructions(importFormattingPrompt.replace('{title}', () => title))
}

// Person and titles of address only: the script's material must survive the
// pass, which the caller verifies before storing the result
export function buildDirectAddressPrompt(): string {
  return withImportInstructions(directAddressPrompt)
}

export function getScriptRefinementPrompt(instruction: string, structure?: ScriptFsTree): string {
  const prompt = scriptRefinementPrompt
    .replace('{targetWords}', String(SECTION_TARGET_WORDS))
    .replace('{instruction}', () => instruction.trim())

  return appendStructureBlock(prompt, structure)
}

// Deliberate exemplar ordering (story 8.8): search returns examples ranked
// most-relevant-first, but few-shot output quality is swayed most by the
// exemplar closest to the instruction — so the prompt places the MOST
// relevant example LAST. This is the single place that ordering rule lives.
// Generic so the same rule can order the examples themselves or anything
// paired with them (their mount paths) without restating the reversal.
export function orderExamplesForPrompt<T>(examples: T[]): T[] {
  return [...examples].reverse()
}

function exampleTagLine(example: ExampleScript): string {
  const tags = typeof example.metadata?.tags === 'string' ? example.metadata.tags.trim() : ''
  return tags ? `Tags: ${tags}\n` : ''
}

function exampleHeading(example: ExampleScript, position: number): string {
  const label = exampleLabel(example)
  return label ? `### Example ${position}: ${label}` : `### Example ${position}`
}

// An empty corpus is an ordinary state — the bundled examples are opt-in — so
// it contributes nothing rather than an empty heading the model has to ignore.
//
// Each example carries the path it is mounted at in the virtual filesystem, so
// the structure block's /examples/ listing and this block name the same thing.
// The paths are assigned in retrieval order (010 is the most relevant) and the
// block is then ordered most-relevant-last, so the numbering runs backwards
// here on purpose.
export function formatExamplesForPrompt(examples: ExampleScript[]): string {
  if (examples.length === 0) return ''

  const mounted = mountExamples(examples)
  const entries = examples.map((example, index) => ({ example, path: mounted[index].path }))

  return '\n## Examples\n\n' +
    orderExamplesForPrompt(entries).map(({ example, path }, index) =>
      `${exampleHeading(example, index + 1)}\n\n` +
      `Path: ${path}\n${exampleTagLine(example)}\n${example.content}`
    ).join('\n\n') + '\n'
}

// The one system message a whole generation run is sent with. Every request
// that writes prose — the outline, each section, each rewrite — must carry the
// identical string: it is both the shared cached prefix and what
// normaliseConversationHistory collapses replayed history down to.
export function buildGenerationSystemPrompt(plan: LengthPlan, examples: ExampleScript[]): string {
  if (examples.length === 0) return getSystemPrompt(plan)
  return getSystemPrompt(plan) + formatExamplesForPrompt(examples)
}

// Examples are sent, never stored: one copy of the corpus per stored
// generation would not fit the browser's storage quota, so the run's
// example-bearing system message is swapped in only on the way out.
// A conversation reloaded from storage has no system turn to replace: the
// serialised form keeps only the user and assistant turns. Prepending one is
// what carries the corpus, and the run's length, into a rewrite after a
// reload.
export function withGenerationSystemPrompt(
  messages: ChatMessage[],
  systemPrompt: string
): ChatMessage[] {
  if (!messages.some(message => message.role === 'system')) {
    return [{ role: 'system', content: systemPrompt }, ...messages]
  }
  return messages.map(message =>
    message.role === 'system' ? { role: 'system', content: systemPrompt } : message
  )
}

// The structure block, like the examples, is sent but never stored: it is a
// snapshot of a document that keeps changing, so replaying it from stored
// history would pin a stale tree in every later request. Appending it to the
// LAST message — the per-request instruction turn built by
// buildConversationHistory — leaves the whole cached prefix untouched. A
// system-first array is never the last message unless it is the only one, in
// which case a fresh user turn carries the block instead.
export function withStructureBlock(
  messages: ChatMessage[],
  structure?: ScriptFsTree
): ChatMessage[] {
  if (!structure) return messages

  const block = buildStructureBlock(structure)
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') {
    return [...messages, { role: 'user', content: block }]
  }

  return [
    ...messages.slice(0, -1),
    { role: 'user', content: `${last.content}\n\n${block}` }
  ]
}

// Conversation-history normalisation (story 8.13): generations store the
// complete messages array each request was sent with, so flattening them for
// a follow-up request can accumulate system messages. Providers behave
// unpredictably with more than one, so prompt assembly enforces the
// invariant: exactly one system message, first, with any later system turn
// that carries different instructions expressed as a user turn instead
// (identical repeats are dropped).
export function normaliseConversationHistory(messages: ChatMessage[]): ChatMessage[] {
  const firstSystem = messages.find(message => message.role === 'system')
  if (!firstSystem) return [...messages]

  const normalised: ChatMessage[] = [firstSystem]
  for (const message of messages) {
    if (message.role !== 'system') {
      normalised.push(message)
    } else if (message !== firstSystem && message.content !== firstSystem.content) {
      normalised.push({ role: 'user', content: message.content })
    }
  }
  return normalised
}

// Flattens every generation's request messages and response into the history
// for a follow-up request (refinement or section regeneration), appending the
// new instruction as a user turn and normalising to a single system message.
export function buildConversationHistory(
  conversation: RawConversation,
  instruction: string
): ChatMessage[] {
  const flattened: ChatMessage[] = []

  for (const generation of conversation.generations) {
    flattened.push(...generation.messages)
    if (generation.response) {
      flattened.push({ role: 'assistant', content: generation.response })
    }
  }

  flattened.push({ role: 'user', content: instruction })

  return normaliseConversationHistory(flattened)
}
