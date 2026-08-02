import { describe, it, expect } from 'vitest'
import { briefingReducer, initialBriefingState } from '../briefingReducer'
import type { BriefQuestion } from '../../services/briefQuestions'

const questions: BriefQuestion[] = [
  { id: 'q1', question: 'Which trigger?', options: [{ label: '"Sink"' }, { label: 'None' }] },
  { id: 'q2', question: 'How does it end?', options: [{ label: 'Awake' }, { label: 'Asleep' }] },
  {
    id: 'q3',
    question: 'What lingers?',
    multiSelect: true,
    options: [{ label: 'The voice' }, { label: 'The trigger' }, { label: 'Obedience' }]
  }
]

// The questionnaire on screen, every question left to the writer
const answering = briefingReducer(initialBriefingState, { type: 'QUESTIONS_RECEIVED', questions })

describe('briefingReducer', () => {
  it('starts every question deferred once the questions arrive', () => {
    expect(answering.phase).toBe('answering')
    expect(answering.notice).toBeNull()
    expect(answering.answers).toEqual({
      q1: { kind: 'deferred' },
      q2: { kind: 'deferred' },
      q3: { kind: 'deferred' }
    })
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
    const state = briefingReducer(answering, {
      type: 'OPTION_CHOSEN',
      questionId: 'q1',
      option: '"Sink"'
    })

    expect(state.answers.q1).toEqual({ kind: 'option', value: '"Sink"' })
    expect(state.answers.q2).toEqual({ kind: 'deferred' })
  })

  it('makes typing the answer, replacing a chosen option', () => {
    const chosen = briefingReducer(answering, {
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
    const typed = briefingReducer(answering, {
      type: 'ANSWER_TYPED',
      questionId: 'q2',
      text: 'left hanging'
    })
    const state = briefingReducer(typed, { type: 'QUESTION_DEFERRED', questionId: 'q2' })

    expect(state.answers.q2).toEqual({ kind: 'deferred' })
    expect(state.questions).toBe(questions)
  })

  it('collects every option ticked on a multi-select question', () => {
    const state = ['The voice', 'Obedience'].reduce(
      (current, option) => briefingReducer(current, { type: 'OPTION_TOGGLED', questionId: 'q3', option }),
      answering
    )

    expect(state.answers.q3).toEqual({
      kind: 'options',
      values: ['The voice', 'Obedience'],
      custom: ''
    })
    expect(state.answers.q1).toEqual({ kind: 'deferred' })
  })

  it('unticks an option that was already ticked', () => {
    const state = ['The voice', 'Obedience', 'The voice'].reduce(
      (current, option) => briefingReducer(current, { type: 'OPTION_TOGGLED', questionId: 'q3', option }),
      answering
    )

    expect(state.answers.q3).toEqual({ kind: 'options', values: ['Obedience'], custom: '' })
  })

  it('leaves a multi-select question to the writer once nothing is ticked', () => {
    const ticked = briefingReducer(answering, {
      type: 'OPTION_TOGGLED',
      questionId: 'q3',
      option: 'The voice'
    })
    const state = briefingReducer(ticked, {
      type: 'OPTION_TOGGLED',
      questionId: 'q3',
      option: 'The voice'
    })

    expect(state.answers.q3).toEqual({ kind: 'deferred' })
  })

  it('keeps typed words beside the ticked options rather than replacing them', () => {
    const ticked = briefingReducer(answering, {
      type: 'OPTION_TOGGLED',
      questionId: 'q3',
      option: 'The trigger'
    })
    const typed = briefingReducer(ticked, {
      type: 'ANSWER_TYPED',
      questionId: 'q3',
      text: 'they sleep better'
    })
    const state = briefingReducer(typed, {
      type: 'OPTION_TOGGLED',
      questionId: 'q3',
      option: 'The voice'
    })

    expect(state.answers.q3).toEqual({
      kind: 'options',
      values: ['The trigger', 'The voice'],
      custom: 'they sleep better'
    })
  })
})
