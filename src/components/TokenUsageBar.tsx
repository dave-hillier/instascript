import { estimateTokenCount } from '../utils/contextWindow'
import type { RawConversation } from '../types/conversation'

interface TokenSegment {
  role: 'system' | 'user' | 'assistant'
  kind: string
  tokens: number
  direction: 'prompt' | 'response'
}

function classifyMessage(
  role: 'system' | 'user' | 'assistant',
  messageIndex: number,
  totalMessages: number,
  generationIndex: number
): { kind: string; direction: 'prompt' | 'response' } {
  if (role === 'system') {
    return { kind: 'System prompt', direction: 'prompt' }
  }
  if (role === 'assistant') {
    return { kind: 'Prior response (history)', direction: 'response' }
  }
  // user role
  if (generationIndex === 0) {
    return { kind: 'User prompt + outline request', direction: 'prompt' }
  }
  if (messageIndex === totalMessages - 1) {
    return { kind: 'Section request', direction: 'prompt' }
  }
  return { kind: 'User prompt', direction: 'prompt' }
}

function buildSegments(conversation: RawConversation): TokenSegment[] {
  if (conversation.generations.length === 0) return []

  const latest = conversation.generations[conversation.generations.length - 1]
  const segments: TokenSegment[] = []

  for (let i = 0; i < latest.messages.length; i++) {
    const msg = latest.messages[i]
    const tokens = estimateTokenCount(msg.content)
    const { kind, direction } = classifyMessage(
      msg.role,
      i,
      latest.messages.length,
      conversation.generations.length - 1
    )
    segments.push({ role: msg.role, kind, tokens, direction })
  }

  if (latest.response) {
    segments.push({
      role: 'assistant',
      kind: 'Current response',
      tokens: estimateTokenCount(latest.response),
      direction: 'response'
    })
  }

  return segments
}

interface TokenUsageBarProps {
  conversation: RawConversation | undefined
}

export const TokenUsageBar = ({ conversation }: TokenUsageBarProps) => {
  if (!conversation || conversation.generations.length === 0) return null

  const segments = buildSegments(conversation)
  const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0)

  if (totalTokens === 0) return null

  return (
    <aside aria-label="Token usage breakdown" className="token-usage">
      <div className="token-usage-header">
        <span>Context tokens</span>
        <span>{totalTokens.toLocaleString()} estimated</span>
      </div>
      <div className="token-usage-bar">
        {segments.map((segment, i) => {
          const widthPercent = (segment.tokens / totalTokens) * 100
          if (widthPercent < 0.5) return null
          return (
            <div
              key={i}
              className="token-usage-segment"
              data-role={segment.role}
              data-direction={segment.direction}
              style={{ width: `${widthPercent}%` }}
              aria-label={`${segment.kind}: ${segment.tokens.toLocaleString()} tokens`}
            >
              <span className="token-usage-tooltip">
                <strong>{segment.direction === 'prompt' ? 'Prompt' : 'Response'}</strong>
                <br />
                {segment.kind}
                <br />
                {segment.tokens.toLocaleString()} tokens ({Math.round(widthPercent)}%)
              </span>
            </div>
          )
        })}
      </div>
      <div className="token-usage-legend">
        <span data-role="system">System</span>
        <span data-role="user">User</span>
        <span data-role="assistant">Assistant</span>
      </div>
    </aside>
  )
}
