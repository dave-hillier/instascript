// Debug transcript capture: when enabled, every request sent to the API
// provider is recorded exactly as it goes out — the full message list
// including the system prompt and the example scripts embedded in it — along
// with the streamed response. Opt-in, kept in memory only, and downloadable
// from Settings so a generation can be inspected end to end.

export interface TranscriptMessage {
  role: string
  content: string
}

export type TranscriptStatus = 'streaming' | 'complete' | 'aborted' | 'error'

export interface TranscriptEntry {
  id: string
  startedAt: number
  endedAt?: number
  provider: string
  model: string
  // What the request was for: 'Outline', a section title, 'Refinement', ...
  label: string
  // Ids of the example scripts that informed this request, when the provider
  // was given examples to embed
  exampleIds?: string[]
  // Any extra request parameters sent alongside the messages
  params?: Record<string, unknown>
  messages: TranscriptMessage[]
  response: string
  status: TranscriptStatus
  error?: string
}

export interface TranscriptRecorder {
  appendChunk(chunk: string): void
  complete(): void
  abort(): void
  fail(error: unknown): void
}

export interface BeginTranscriptInput {
  provider: string
  model: string
  label: string
  messages: TranscriptMessage[]
  exampleIds?: string[]
  params?: Record<string, unknown>
}

// Bounds memory: a long session with the debug flag left on should not grow
// without limit. Oldest entries are dropped first.
export const MAX_TRANSCRIPTS = 100

const STORAGE_KEY = 'debugTranscripts'

export function isTranscriptCaptureEnabled(): boolean {
  try {
    const item = window.localStorage.getItem(STORAGE_KEY)
    return item ? JSON.parse(item) === true : false
  } catch (error) {
    console.warn('Error loading transcript capture setting from localStorage:', error)
    return false
  }
}

let entries: TranscriptEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeToTranscripts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Stable snapshot for useSyncExternalStore: the array identity only changes
// when something was recorded
export function getTranscripts(): TranscriptEntry[] {
  return entries
}

export function clearTranscripts(): void {
  entries = []
  notify()
}

// Discards everything: what capture-off returns, and a safe placeholder for a
// request that fails before recording starts
export const NO_TRANSCRIPT: TranscriptRecorder = {
  appendChunk: () => {},
  complete: () => {},
  abort: () => {},
  fail: () => {}
}

// Starts recording a provider request. Returns a no-op recorder when capture
// is switched off, so callers can record unconditionally.
export function beginTranscript(input: BeginTranscriptInput): TranscriptRecorder {
  if (!isTranscriptCaptureEnabled()) return NO_TRANSCRIPT

  const entry: TranscriptEntry = {
    id: `transcript-${nextId++}`,
    startedAt: Date.now(),
    provider: input.provider,
    model: input.model,
    label: input.label,
    exampleIds: input.exampleIds && input.exampleIds.length > 0 ? input.exampleIds : undefined,
    params: input.params,
    // Copied so later mutation of the caller's array cannot rewrite history
    messages: input.messages.map(message => ({ role: message.role, content: message.content })),
    response: '',
    status: 'streaming'
  }

  entries = [...entries, entry].slice(-MAX_TRANSCRIPTS)
  notify()

  // Subscribers are told about starts and endings only: notifying per streamed
  // chunk would re-render them once per token for no added information. The
  // stored entry still carries the partial response, so a download taken
  // mid-stream is complete up to that moment.
  const update = (changes: Partial<TranscriptEntry>, silent = false): void => {
    const index = entries.findIndex(candidate => candidate.id === entry.id)
    // The entry may have aged out of the buffer, or been cleared, mid-stream
    if (index === -1) return
    entries = [
      ...entries.slice(0, index),
      { ...entries[index], ...changes },
      ...entries.slice(index + 1)
    ]
    if (!silent) notify()
  }

  let response = ''

  return {
    appendChunk: (chunk: string) => {
      response += chunk
      update({ response }, true)
    },
    complete: () => {
      update({ response, status: 'complete', endedAt: Date.now() })
    },
    abort: () => {
      update({ response, status: 'aborted', endedAt: Date.now() })
    },
    fail: (error: unknown) => {
      update({
        response,
        status: 'error',
        endedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

// What a provider knows about the request it is about to send, beyond the
// messages themselves
export interface TranscriptContext {
  label: string
  exampleIds?: string[]
}

// Provider message shapes carry richer content types than a transcript needs;
// non-string content is stringified so nothing is silently dropped
export function toTranscriptMessages(
  messages: Array<{ role: string; content?: unknown }>
): TranscriptMessage[] {
  return messages.map(message => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content === undefined || message.content === null
        ? ''
        : JSON.stringify(message.content)
  }))
}

// The ids of the examples embedded in a request, named the same way the
// example corpus records selections
export function exampleIdsOf(
  examples?: Array<{ metadata?: Record<string, unknown> }>
): string[] {
  if (!examples) return []
  return examples
    .map(example => String(example.metadata?.id ?? example.metadata?.filename ?? ''))
    .filter(Boolean)
}

export const TRANSCRIPT_EXPORT_FORMAT = 'instascript-transcripts'
export const TRANSCRIPT_EXPORT_VERSION = 1

export interface TranscriptExport {
  format: string
  version: number
  exportedAt: string
  transcripts: TranscriptEntry[]
}

export function buildTranscriptExport(
  transcripts: TranscriptEntry[],
  exportedAt: string
): TranscriptExport {
  return {
    format: TRANSCRIPT_EXPORT_FORMAT,
    version: TRANSCRIPT_EXPORT_VERSION,
    exportedAt,
    transcripts
  }
}

export function serializeTranscripts(
  transcripts: TranscriptEntry[],
  exportedAt: string
): string {
  return JSON.stringify(buildTranscriptExport(transcripts, exportedAt), null, 2)
}

// Readable rendering of the same data, for reading a run through rather than
// diffing it
export function formatTranscriptsAsText(transcripts: TranscriptEntry[]): string {
  return transcripts
    .map(entry => {
      const header = [
        `=== ${entry.label} (${entry.provider} / ${entry.model}) ===`,
        `started: ${new Date(entry.startedAt).toISOString()}`,
        `status: ${entry.status}${entry.error ? ` - ${entry.error}` : ''}`,
        entry.exampleIds ? `examples: ${entry.exampleIds.join(', ')}` : null
      ]
        .filter(Boolean)
        .join('\n')

      const messages = entry.messages
        .map(message => `--- ${message.role} ---\n${message.content}`)
        .join('\n\n')

      return `${header}\n\n${messages}\n\n--- response ---\n${entry.response}`
    })
    .join('\n\n\n')
}
