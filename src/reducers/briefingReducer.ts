import type { BriefAnswers, BriefQuestion } from '../services/briefQuestions'

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
      return {
        ...state,
        answers: {
          ...state.answers,
          [action.questionId]: { kind: 'option', value: action.option }
        }
      }

    // Typing is itself the choice: the custom answer becomes the one selected
    // without a separate radio to remember to click
    case 'ANSWER_TYPED':
      return {
        ...state,
        answers: {
          ...state.answers,
          [action.questionId]: { kind: 'custom', value: action.text }
        }
      }

    case 'QUESTION_DEFERRED':
      return {
        ...state,
        answers: {
          ...state.answers,
          [action.questionId]: { kind: 'deferred' }
        }
      }

    default:
      return state
  }
}
