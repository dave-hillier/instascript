import { describe, it, expect } from 'vitest'
import { briefingReducer, initialBriefingState } from '../briefingReducer'
import type { BriefQuestion } from '../../services/briefQuestions'

const questions: BriefQuestion[] = [
  { id: 'q1', question: 'Which trigger?', options: [{ label: '"Sink"' }, { label: 'None' }] },
  { id: 'q2', question: 'How does it end?', options: [{ label: 'Awake' }, { label: 'Asleep' }] }
]

describe('briefingReducer', () => {
  it('starts every question deferred once the questions arrive', () => {
    const state = briefingReducer(initialBriefingState, { type: 'QUESTIONS_RECEIVED', questions })

    expect(state.phase).toBe('answering')
    expect(state.notice).toBeNull()
    expect(state.answers).toEqual({ q1: { kind: 'deferred' }, q2: { kind: 'deferred' } })
  })

  it('says why the questions are the built-in ones when the request failed', () => {
    const state = briefingReducer(initialBriefingState, {
      type: 'QUESTIONS_FAILED',
      questions,
      reason: 'rejected key'
    })

    expect(state.phase).toBe('answering')
    expect(state.notice).toBe('rejected key')
    expect(state.answers.q1).toEqual({ kind: 'deferred' })
  })

  it('records a chosen option without touching the other questions', () => {
    const received = briefingReducer(initialBriefingState, { type: 'QUESTIONS_RECEIVED', questions })
    const state = briefingReducer(received, {
      type: 'OPTION_CHOSEN',
      questionId: 'q1',
      option: '"Sink"'
    })

    expect(state.answers.q1).toEqual({ kind: 'option', value: '"Sink"' })
    expect(state.answers.q2).toEqual({ kind: 'deferred' })
  })

  it('makes typing the answer, replacing a chosen option', () => {
    const received = briefingReducer(initialBriefingState, { type: 'QUESTIONS_RECEIVED', questions })
    const chosen = briefingReducer(received, {
      type: 'OPTION_CHOSEN',
      questionId: 'q1',
      option: '"Sink"'
    })
    const state = briefingReducer(chosen, {
      type: 'ANSWER_TYPED',
      questionId: 'q1',
      text: 'the word "heavy"'
    })

    expect(state.answers.q1).toEqual({ kind: 'custom', value: 'the word "heavy"' })
  })

  it('hands a question back to the writer', () => {
    const received = briefingReducer(initialBriefingState, { type: 'QUESTIONS_RECEIVED', questions })
    const typed = briefingReducer(received, {
      type: 'ANSWER_TYPED',
      questionId: 'q2',
      text: 'left hanging'
    })
    const state = briefingReducer(typed, { type: 'QUESTION_DEFERRED', questionId: 'q2' })

    expect(state.answers.q2).toEqual({ kind: 'deferred' })
    expect(state.questions).toBe(questions)
  })
})
