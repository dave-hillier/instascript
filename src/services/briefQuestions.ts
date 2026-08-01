// The optional briefing stage: before a script is generated, one request asks
// the model what it still needs to know about the brief, and the user answers
// a short multiple-choice questionnaire. The answers are folded back into the
// brief, so everything downstream — outline, sections, reviews — sees one
// enriched brief and nothing else in the pipeline changes.
//
// Parsing a model's reply and turning answers into a brief are pure functions
// here; the prompt itself is built in prompts.ts from brief-questions.txt.

import type { ChatMessage } from '../types/conversation'
import type { ScriptGenerationService } from './scriptGenerationService'
import { buildBriefQuestionsPrompt } from './prompts'

// Marker used as the RegenerationRequest section title for the questions
// request; real providers ignore it, and the mock uses it to return a
// questionnaire-shaped response.
export const BRIEF_QUESTIONS_SECTION_TITLE = '__brief_questions__'

// Parse tolerances, deliberately a little looser than what the prompt asks
// for: a model that returns one question too many is still useful, one that
// returns twenty is not a questionnaire.
export const MAX_QUESTIONS = 6
export const MAX_OPTIONS_PER_QUESTION = 6
const MIN_OPTIONS_PER_QUESTION = 2
const MAX_QUESTION_LENGTH = 300
const MAX_OPTION_LENGTH = 200

export interface BriefQuestionOption {
  label: string
  // The model's one-line gloss on what choosing this option would mean
  detail?: string
}

export interface BriefQuestion {
  id: string
  question: string
  options: BriefQuestionOption[]
}

// One question's answer. "deferred" is the decide-for-me case: the question
// still reaches the model, marked as the writer's own call.
export type BriefAnswer =
  | { kind: 'option'; value: string }
  | { kind: 'custom'; value: string }
  | { kind: 'deferred' }

export type BriefAnswers = Record<string, BriefAnswer>

// "Q:", "Q1.", "Question 2)" and a markdown heading all introduce a question
const QUESTION_PREFIX = /^(?:#{1,6}\s*)?(?:Q(?:uestion)?)\s*\d*\s*[:.)]\s*/i
// Bullets, "a)" and "1." all introduce an option
const OPTION_PREFIX = /^(?:[-*•]\s+|[A-Za-z][).]\s+|\d+[).]\s+)/
// The label and its gloss, as asked for ("label | gloss") or as a dash-
// separated line a less obedient model returns instead. A plain hyphen is not
// a separator: it belongs to hyphenated words.
const OPTION_SPLIT = /\s*\|\s*|\s+[—–]\s+/

// Emphasis markers a model adds around its own text. Quotes are left alone:
// a trigger word is usually quoted, and the quotes are part of the answer.
function stripDecoration(text: string): string {
  return text.replace(/\*\*|__/g, '').trim()
}

function parseOption(text: string): BriefQuestionOption | null {
  const [rawLabel, ...rest] = text.split(OPTION_SPLIT)
  const label = stripDecoration(rawLabel ?? '')
  if (!label || label.length > MAX_OPTION_LENGTH) return null

  const detail = stripDecoration(rest.join(' — '))
  return detail ? { label, detail } : { label }
}

// Pure: the questionnaire from a model reply. The asked-for format is one
// "Q:" line followed by bulleted options, but the parser also accepts an
// unprefixed line ending in a question mark, so a model that drops the marker
// still produces a usable set. A question that ends up with fewer than two
// options is dropped rather than shown as a single-choice.
export function parseBriefQuestions(text: string): BriefQuestion[] {
  const questions: { question: string; options: BriefQuestionOption[] }[] = []
  const seen = new Set<string>()
  // A question that was rejected still owns the option lines beneath it, so
  // they are dropped rather than piled onto the question before it
  let skipping = false

  const startQuestion = (raw: string) => {
    const question = stripDecoration(raw)
    const key = question.toLowerCase()
    skipping = !question || question.length > MAX_QUESTION_LENGTH || seen.has(key)
    if (skipping) return
    seen.add(key)
    questions.push({ question, options: [] })
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (QUESTION_PREFIX.test(trimmed)) {
      startQuestion(trimmed.replace(QUESTION_PREFIX, ''))
      continue
    }

    if (OPTION_PREFIX.test(trimmed)) {
      if (skipping) continue

      const body = trimmed.replace(OPTION_PREFIX, '')
      const current = questions[questions.length - 1]
      // A bulleted line before any question, phrased as a question, is the
      // question itself under a bullet rather than an orphaned option
      if (!current) {
        if (body.trim().endsWith('?')) startQuestion(body)
        continue
      }
      if (current.options.length >= MAX_OPTIONS_PER_QUESTION) continue
      const option = parseOption(body)
      if (option && !current.options.some(existing => existing.label === option.label)) {
        current.options.push(option)
      }
      continue
    }

    // An unmarked line is only a question when it reads as one; anything else
    // is preamble or commentary the prompt asked for and did not get
    if (trimmed.endsWith('?')) startQuestion(trimmed)
  }

  return questions
    .filter(entry => entry.options.length >= MIN_OPTIONS_PER_QUESTION)
    .slice(0, MAX_QUESTIONS)
    .map((entry, index) => ({ id: `q${index + 1}`, ...entry }))
}

// The questions asked when the model cannot be reached, or replies with
// nothing usable. They cover what the brief most often leaves unsaid — the
// trigger, what lingers afterwards, who is speaking to whom, and how it ends
// — so the stage is still worth something without a live provider.
export function defaultBriefQuestions(): BriefQuestion[] {
  return [
    {
      id: 'q1',
      question: 'Should the script plant a trigger?',
      options: [
        { label: 'A single word — "sink"', detail: 'Hearing it drops the listener straight down' },
        { label: 'A spoken phrase — "eyes on me"', detail: 'Said aloud to return them to trance' },
        { label: 'A touch or gesture', detail: 'A snap of the fingers, a hand at the throat' },
        { label: 'No trigger this time', detail: 'The session stands on its own' }
      ]
    },
    {
      id: 'q2',
      question: 'What should still be working after the session ends?',
      options: [
        { label: 'The voice pulls them back', detail: 'Hearing it again drops them faster each time' },
        { label: 'Arousal returns on the trigger', detail: 'The body answers before the mind does' },
        { label: 'Obedience carries into the day', detail: 'Following stays easy once they wake' },
        { label: 'Nothing lasting', detail: 'The effects end when the script does' }
      ]
    },
    {
      id: 'q3',
      question: 'Who is speaking, and who is listening?',
      options: [
        { label: 'A female hypnotist to a male subject', detail: 'The standing default' },
        { label: 'A male hypnotist to a female subject', detail: 'The reverse pairing' },
        { label: 'Same-gender pairing', detail: 'Written for a listener of the same gender' },
        { label: 'Left unstated', detail: 'Anyone can read it aloud to anyone' }
      ]
    },
    {
      id: 'q4',
      question: 'How should the script end?',
      options: [
        { label: 'Awake and alert', detail: 'Counted up, carrying the suggestions' },
        { label: 'Drifting into sleep', detail: 'Trance runs straight into rest' },
        { label: 'Held under', detail: 'Left deep, waiting to be woken by someone else' }
      ]
    }
  ]
}

// How a question the user left to the writer is stated in the brief. It is
// carried rather than dropped: the question was worth asking, so the script
// should still settle it deliberately.
const DEFERRED_ANSWER = 'your choice — decide what serves the script best'

// The answer as the writer should read it, including the model's own gloss on
// the option so the direction is as specific as the questionnaire was
function describeAnswer(question: BriefQuestion, answer: BriefAnswer): string {
  if (answer.kind === 'custom') return answer.value.trim()
  if (answer.kind === 'deferred') return DEFERRED_ANSWER

  const option = question.options.find(entry => entry.label === answer.value)
  if (!option) return answer.value
  return option.detail ? `${option.label} (${option.detail})` : option.label
}

// Pure: whether an answer says anything. A deferred question, or a custom
// answer left empty, does not.
function isAnswered(answer: BriefAnswer | undefined): answer is BriefAnswer {
  if (!answer || answer.kind === 'deferred') return false
  return answer.value.trim().length > 0
}

// Pure: the brief that generation actually receives. Answers are appended to
// the user's own words rather than rewriting them, so the brief stays
// recognisably theirs in the conversation thread. A questionnaire nobody
// answered leaves the brief exactly as it was typed.
export function buildBriefedPrompt(
  brief: string,
  questions: BriefQuestion[],
  answers: BriefAnswers
): string {
  const trimmedBrief = brief.trim()
  if (questions.length === 0) return trimmedBrief
  if (!questions.some(question => isAnswered(answers[question.id]))) return trimmedBrief

  const lines = questions.map(question => {
    const answer = answers[question.id]
    const described = isAnswered(answer) ? describeAnswer(question, answer) : DEFERRED_ANSWER
    return `- ${question.question} ${described}`
  })

  return `${trimmedBrief}\n\nDirection from the briefing questions:\n${lines.join('\n')}`
}

// One request, off the conversation entirely: the questionnaire is asked
// before a script or a conversation exists, and its reply is never stored as
// a generation. It goes to the generation model rather than the utility one —
// the questions are about the erotic content itself, which is the model the
// user chose for exactly that.
export async function requestBriefQuestions(
  service: Pick<ScriptGenerationService, 'regenerateSection'>,
  brief: string,
  abortSignal?: AbortSignal
): Promise<BriefQuestion[]> {
  const prompt = buildBriefQuestionsPrompt(brief)
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]

  let text = ''
  for await (const chunk of service.regenerateSection(
    { prompt, conversationId: '', sectionTitle: BRIEF_QUESTIONS_SECTION_TITLE },
    messages,
    abortSignal
  )) {
    text += chunk
  }

  const questions = parseBriefQuestions(text)
  return questions.length > 0 ? questions : defaultBriefQuestions()
}
