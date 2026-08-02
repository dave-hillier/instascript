import { useEffect, useReducer } from 'react'
import { Sparkles } from 'lucide-react'
import { briefingReducer, initialBriefingState } from '../reducers/briefingReducer'
import {
  buildBriefedPrompt,
  defaultBriefQuestions,
  requestBriefQuestions,
  type BriefAnswer,
  type BriefQuestion
} from '../services/briefQuestions'
import { createScriptService } from '../services/serviceFactory'

interface BriefingStageProps {
  brief: string
  // The brief to generate from — the original with the answers appended, or
  // the original unchanged when the questions were skipped or all deferred
  onReady: (prompt: string) => void
  // Back to the composer with the typed brief intact
  onBack: () => void
}

interface QuestionFieldsetProps {
  question: BriefQuestion
  answer: BriefAnswer
  onOptionChosen: (option: string) => void
  onOptionToggled: (option: string) => void
  onAnswerTyped: (text: string) => void
  onDeferred: () => void
}

// What a question shows before the user touches it: the writer's call
const DEFERRED: BriefAnswer = { kind: 'deferred' }

// Whether an option is chosen, on a question of either kind
function isChosen(answer: BriefAnswer, label: string): boolean {
  if (answer.kind === 'options') return answer.values.includes(label)
  return answer.kind === 'option' && answer.value === label
}

// The user's own words as the question currently holds them. A multi-select
// question keeps them beside its ticked options; a single-choice one only has
// them when nothing was picked from the list.
function typedAnswer(answer: BriefAnswer): string {
  if (answer.kind === 'options') return answer.custom
  return answer.kind === 'custom' ? answer.value : ''
}

// A question taking any number of answers: checkboxes, and nothing ticked
// means the writer decides, so it needs no "decide for me" of its own. One
// taking a single answer keeps the radio group, where "something else" and
// "decide for me" are choices in the same list.
const QuestionFieldset = ({
  question,
  answer,
  onOptionChosen,
  onOptionToggled,
  onAnswerTyped,
  onDeferred
}: QuestionFieldsetProps) => {
  const multiSelect = question.multiSelect === true

  return (
    <fieldset data-select={multiSelect ? 'many' : 'one'}>
      <legend>{question.question}</legend>
      {multiSelect && <p>Choose as many as fit — or none, and the writer decides.</p>}

      {question.options.map(option => (
        <label key={option.label}>
          <input
            type={multiSelect ? 'checkbox' : 'radio'}
            name={question.id}
            value={option.label}
            checked={isChosen(answer, option.label)}
            onChange={() =>
              multiSelect ? onOptionToggled(option.label) : onOptionChosen(option.label)
            }
          />
          <span>
            {option.label}
            {option.detail && <small>{option.detail}</small>}
          </span>
        </label>
      ))}

      {!multiSelect && (
        <label>
          <input
            type="radio"
            name={question.id}
            checked={answer.kind === 'custom'}
            onChange={() => onAnswerTyped('')}
          />
          <span>Something else</span>
        </label>
      )}
      <input
        type="text"
        className="briefing-custom"
        placeholder={multiSelect ? 'Anything else, in your own words' : 'In your own words'}
        aria-label={`Your own answer: ${question.question}`}
        value={typedAnswer(answer)}
        onChange={event => onAnswerTyped(event.target.value)}
      />

      {!multiSelect && (
        <label>
          <input
            type="radio"
            name={question.id}
            checked={answer.kind === 'deferred'}
            onChange={onDeferred}
          />
          <span>Decide for me</span>
        </label>
      )}
    </fieldset>
  )
}

// The optional briefing stage (story 1.10): between the brief and the first
// generated word, the model asks what the brief leaves open and the answers
// are folded back into it. Every question defaults to "decide for me", so the
// stage can always be answered by pressing the button.
export const BriefingStage = ({ brief, onReady, onBack }: BriefingStageProps) => {
  const [state, dispatch] = useReducer(briefingReducer, initialBriefingState)

  // One request, fired once for this brief. Leaving the stage aborts it: the
  // questions are worthless to a run that has already started.
  useEffect(() => {
    const controller = new AbortController()

    const ask = async () => {
      try {
        const questions = await requestBriefQuestions(
          createScriptService(),
          brief,
          controller.signal
        )
        if (controller.signal.aborted) return
        dispatch({ type: 'QUESTIONS_RECEIVED', questions })
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn('Could not ask briefing questions', error)
        dispatch({
          type: 'QUESTIONS_FAILED',
          questions: defaultBriefQuestions(),
          reason: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    void ask()
    return () => controller.abort()
  }, [brief])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onReady(buildBriefedPrompt(brief, state.questions, state.answers))
  }

  return (
    <section className="briefing" aria-labelledby="briefing-heading">
      <h2 id="briefing-heading">
        <Sparkles size={18} aria-hidden="true" />
        A few questions first
      </h2>
      <blockquote className="briefing-brief">{brief}</blockquote>

      {state.phase === 'asking' ? (
        <div className="briefing-waiting" aria-busy="true">
          <p role="status">Working out what to ask…</p>
          <div className="briefing-actions">
            <button type="button" onClick={() => onReady(brief.trim())}>
              Skip the questions
            </button>
            <button type="button" onClick={onBack}>
              Edit the brief
            </button>
          </div>
        </div>
      ) : (
        <form className="briefing-form" onSubmit={handleSubmit}>
          {state.notice && (
            <p role="status" className="briefing-notice">
              These are the standard questions — the model could not be reached
              for ones written for this brief ({state.notice})
            </p>
          )}

          {state.questions.map(question => (
            <QuestionFieldset
              key={question.id}
              question={question}
              answer={state.answers[question.id] ?? DEFERRED}
              onOptionChosen={option =>
                dispatch({ type: 'OPTION_CHOSEN', questionId: question.id, option })
              }
              onOptionToggled={option =>
                dispatch({ type: 'OPTION_TOGGLED', questionId: question.id, option })
              }
              onAnswerTyped={text =>
                dispatch({ type: 'ANSWER_TYPED', questionId: question.id, text })
              }
              onDeferred={() => dispatch({ type: 'QUESTION_DEFERRED', questionId: question.id })}
            />
          ))}

          <div className="briefing-actions">
            <button type="submit">Write the script</button>
            <button type="button" onClick={onBack}>
              Edit the brief
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
