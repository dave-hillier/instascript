import type OpenAI from 'openai'
import type { GenerationRequest, RegenerationRequest, ChatMessage } from '../types/conversation'
import type { ExampleScript } from './exampleSearchService'
import type { ProviderFrame } from './providerFrame'
import type { ToolSpec } from './writingTools'

// A turn that only exists on the wire. `Generation.messages` is typed
// `ChatMessage[]` — system, user or assistant, content always a string — and
// libraryTransfer THROWS on any other role, which would abort a whole library
// import. So the tool exchange (the assistant turn that made a call, and the
// tool result answering it) is modelled separately here, passed at send time
// only, and never stored on a generation.
export interface AssistantToolCallTurn {
  role: 'assistant'
  content?: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
}

export interface ToolResultTurn {
  role: 'tool'
  toolCallId: string
  content: string
}

export type ProviderTurn = AssistantToolCallTurn | ToolResultTurn

// What a caller wants added to a request beyond its messages: the tools the
// model may call, and any tool exchange to replay. Optional throughout, so the
// prose path sends byte-identical requests to the ones it always did.
export interface ProviderCallOptions {
  tools?: readonly ToolSpec[]
  // Appended after `messages`, in order. A tool result must follow the
  // assistant turn that made the call it answers, so the caller builds the
  // pair and hands both over together.
  toolTurns?: ProviderTurn[]
}

// The one conversion from our wire-only turns to the provider's own shape,
// shared by every OpenAI-compatible service so the two cannot drift.
export function toolTurnsToOpenAI(
  turns: ProviderTurn[] | undefined
): Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
  return (turns ?? []).map(turn =>
    turn.role === 'tool'
      ? { role: 'tool' as const, tool_call_id: turn.toolCallId, content: turn.content }
      : {
          role: 'assistant' as const,
          content: turn.content ?? null,
          tool_calls: turn.toolCalls.map(call => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments }
          }))
        }
  )
}

export interface ScriptGenerationService {
  generateScript(
    request: GenerationRequest,
    messages?: ChatMessage[],
    examples?: ExampleScript[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown>

  regenerateSection(
    request: RegenerationRequest,
    messages: ChatMessage[],
    abortSignal?: AbortSignal,
    options?: ProviderCallOptions
  ): AsyncGenerator<ProviderFrame, void, unknown>
}
