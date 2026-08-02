import type { BriefAnswer, BriefAnswers, BriefQuestion } from '../services/briefQuestions'

// State for the optional briefing stage (story 1.10): one request is in
// flight, then the questionnaire is on screen being answered. Every question
// starts deferred, so submitting without touching anything means "decide it
// all for me" and the brief goes through as typed.

export interface BriefingState {
  phase: 'asking' | 'answering'
  questions: BriefQuestion[]
  answers: BriefAnswers
  // Why the questions on screen are the built-in ones rather than the
  // model's; null when nothing went wrong
  notice: string | null
}

export type BriefingAction =
  | { type: 'QUESTIONS_RECEIVED'; questions: BriefQuestion[] }
  | { type: 'QUESTIONS_FAILED'; questions: BriefQuestion[]; reason: string }
  | { type: 'OPTION_CHOSEN'; questionId: string; option: string }
  | { type: 'OPTION_TOGGLED'; questionId: string; option: string }
  | { type: 'ANSWER_TYPED'; questionId: string; text: string }
  | { type: 'QUESTION_DEFERRED'; questionId: string }

export const initialBriefingState: BriefingState = {
  phase: 'asking',
  questions: [],
  answers: {},
  notice: null
}

function deferAll(questions: BriefQuestion[]): BriefAnswers {
  return Object.fromEntries(
    questions.map(question => [question.id, { kind: 'deferred' as const }])
  )
}

// What a multi-select question has collected so far. Every other kind of
// answer — a question only just touched, or one handed back to the writer —
// starts it empty.
function ticked(answer: BriefAnswer | undefined): { values: string[]; custom: string } {
  return answer?.kind === 'options' ? answer : { values: [], custom: '' }
}

// A multi-select answer, or "deferred" once nothing is ticked and nothing is
// typed: on a question that takes any number of answers, choosing none is
// itself the writer's-call state, with no separate control to press.
function collected(values: string[], custom: string): BriefAnswer {
  if (values.length === 0 && !custom) return { kind: 'deferred' }
  return { kind: 'options', values, custom }
}

function withAnswer(
  state: BriefingState,
  questionId: string,
  answer: BriefAnswer
): BriefingState {
  return { ...state, answers: { ...state.answers, [questionId]: answer } }
}

export function briefingReducer(state: BriefingState, action: BriefingAction): BriefingState {
  switch (action.type) {
    case 'QUESTIONS_RECEIVED':
      return {
        phase: 'answering',
        questions: action.questions,
        answers: deferAll(action.questions),
        notice: null
      }

    case 'QUESTIONS_FAILED':
      return {
        phase: 'answering',
        questions: action.questions,
        answers: deferAll(action.questions),
        notice: action.reason
      }

    case 'OPTION_CHOSEN':
      return withAnswer(state, action.questionId, { kind: 'option', value: action.option })

    // A multi-select question: the option joins what is already ticked, or
    // leaves it, and everything else the question had collected stays
    case 'OPTION_TOGGLED': {
      const { values, custom } = ticked(state.answers[action.questionId])
      const next = values.includes(action.option)
        ? values.filter(value => value !== action.option)
        : [...values, action.option]

      return withAnswer(state, action.questionId, collected(next, custom))
    }

    // Typing is itself the choice: the custom answer becomes the one selected
    // without a separate radio to remember to click. On a multi-select
    // question it sits alongside the ticked options instead of replacing
    // them, which is what ticking several answers implies.
    case 'ANSWER_TYPED': {
      const question = state.questions.find(entry => entry.id === action.questionId)
      if (!question?.multiSelect) {
        return withAnswer(state, action.questionId, { kind: 'custom', value: action.text })
      }

      return withAnswer(
        state,
        action.questionId,
        collected(ticked(state.answers[action.questionId]).values, action.text)
      )
    }

    case 'QUESTION_DEFERRED':
      return withAnswer(state, action.questionId, { kind: 'deferred' })

    default:
      return state
  }
}
