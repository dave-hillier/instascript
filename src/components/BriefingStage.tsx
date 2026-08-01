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
  onAnswerTyped: (text: string) => void
  onDeferred: () => void
}

// What a question shows before the user touches it: the writer's call
const DEFERRED: BriefAnswer = { kind: 'deferred' }

const QuestionFieldset = ({
  question,
  answer,
  onOptionChosen,
  onAnswerTyped,
  onDeferred
}: QuestionFieldsetProps) => (
  <fieldset>
    <legend>{question.question}</legend>

    {question.options.map(option => (
      <label key={option.label}>
        <input
          type="radio"
          name={question.id}
          value={option.label}
          checked={answer.kind === 'option' && answer.value === option.label}
          onChange={() => onOptionChosen(option.label)}
        />
        <span>
          {option.label}
          {option.detail && <small>{option.detail}</small>}
        </span>
      </label>
    ))}

    <label>
      <input
        type="radio"
        name={question.id}
        checked={answer.kind === 'custom'}
        onChange={() => onAnswerTyped('')}
      />
      <span>Something else</span>
    </label>
    <input
      type="text"
      className="briefing-custom"
      placeholder="In your own words"
      aria-label={`Your own answer: ${question.question}`}
      value={answer.kind === 'custom' ? answer.value : ''}
      onChange={event => onAnswerTyped(event.target.value)}
    />

    <label>
      <input
        type="radio"
        name={question.id}
        checked={answer.kind === 'deferred'}
        onChange={onDeferred}
      />
      <span>Decide for me</span>
    </label>
  </fieldset>
)

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
