import type { RawConversation } from '../types/conversation'
import {
  estimateConversationTokens,
  estimateCostUsd,
  formatCostUsd
} from '../services/generationCost'

interface ScriptCostSummaryProps {
  conversation: RawConversation | undefined
  model: string
}

// Cumulative estimated spend for a script (story 8.12): input and output
// tokens across every generation of its conversation, priced where the
// model is in the static pricing table. Everything here is an estimate and
// labelled as such.
export const ScriptCostSummary = ({ conversation, model }: ScriptCostSummaryProps) => {
  if (!conversation || conversation.generations.length === 0) return null

  const totals = estimateConversationTokens(conversation)
  if (totals.inputTokens + totals.outputTokens === 0) return null

  const cost = estimateCostUsd(totals, model)
  const generationsLabel = `${totals.generationCount} ${
    totals.generationCount === 1 ? 'generation' : 'generations'
  }`

  return (
    <aside aria-label="Estimated token spend for this script" className="script-cost">
      <div className="script-cost-header">
        <span>Estimated spend</span>
        <span>{generationsLabel}</span>
      </div>
      <p>
        ~{totals.inputTokens.toLocaleString()} input / ~
        {totals.outputTokens.toLocaleString()} output tokens
        {cost !== null ? (
          <> · approx. {formatCostUsd(cost)} at {model} rates</>
        ) : (
          <> · no pricing known for {model}</>
        )}
      </p>
      <p className="script-cost-note">
        Token counts{cost !== null ? ' and cost are estimates' : ' are estimates'}, summed
        across every generation of this script.
      </p>
    </aside>
  )
}
