import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  beginTranscript,
  clearTranscripts,
  getTranscripts,
  subscribeToTranscripts,
  serializeTranscripts,
  formatTranscriptsAsText,
  exampleIdsOf,
  toTranscriptMessages,
  isTranscriptCaptureEnabled,
  MAX_TRANSCRIPTS,
  TRANSCRIPT_EXPORT_FORMAT
} from '../debugTranscript'

const stubCapture = (enabled: boolean): void => {
  const store = new Map<string, string>()
  store.set('debugTranscripts', JSON.stringify(enabled))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, next: string) => store.set(key, next),
      removeItem: (key: string) => store.delete(key)
    }
  })
}

const messages = [
  { role: 'system', content: 'STYLE RULES\n\n## Example: Falling\nExample body' },
  { role: 'user', content: 'Write a script about falling' }
]

beforeEach(() => {
  clearTranscripts()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capture toggle', () => {
  it('records nothing while switched off', () => {
    stubCapture(false)
    expect(isTranscriptCaptureEnabled()).toBe(false)

    const recorder = beginTranscript({ provider: 'openai', model: 'gpt-5', label: 'Generation', messages })
    recorder.appendChunk('text')
    recorder.complete()

    expect(getTranscripts()).toEqual([])
  })

  it('records the full outgoing messages and the streamed reply when switched on', () => {
    stubCapture(true)

    const recorder = beginTranscript({
      provider: 'openai',
      model: 'gpt-5',
      label: 'Generation',
      exampleIds: ['falling.md'],
      messages
    })
    recorder.appendChunk('Once ')
    recorder.appendChunk('upon')
    recorder.complete()

    const [entry] = getTranscripts()
    expect(entry.provider).toBe('openai')
    expect(entry.model).toBe('gpt-5')
    expect(entry.label).toBe('Generation')
    expect(entry.exampleIds).toEqual(['falling.md'])
    // The examples live inside the system message, and are kept verbatim
    expect(entry.messages[0].content).toContain('## Example: Falling')
    expect(entry.messages).toHaveLength(2)
    expect(entry.response).toBe('Once upon')
    expect(entry.status).toBe('complete')
  })

  it('keeps what streamed before an abort or a failure', () => {
    stubCapture(true)

    const aborted = beginTranscript({ provider: 'mock', model: 'mock', label: 'Opening', messages })
    aborted.appendChunk('partial')
    aborted.abort()

    const failed = beginTranscript({ provider: 'mock', model: 'mock', label: 'Closing', messages })
    failed.appendChunk('some')
    failed.fail(new Error('rate limited'))

    const [first, second] = getTranscripts()
    expect(first.status).toBe('aborted')
    expect(first.response).toBe('partial')
    expect(second.status).toBe('error')
    expect(second.error).toBe('rate limited')
    expect(second.response).toBe('some')
  })

  it('keeps a copy, so mutating the caller\'s messages cannot rewrite history', () => {
    stubCapture(true)

    const sent = [{ role: 'user', content: 'original' }]
    beginTranscript({ provider: 'mock', model: 'mock', label: 'Opening', messages: sent }).complete()
    sent[0].content = 'changed'

    expect(getTranscripts()[0].messages[0].content).toBe('original')
  })

  it('drops the oldest entries past the buffer limit', () => {
    stubCapture(true)

    for (let i = 0; i < MAX_TRANSCRIPTS + 3; i++) {
      beginTranscript({ provider: 'mock', model: 'mock', label: `Section ${i}`, messages }).complete()
    }

    const transcripts = getTranscripts()
    expect(transcripts).toHaveLength(MAX_TRANSCRIPTS)
    expect(transcripts[0].label).toBe('Section 3')
  })
})

describe('subscribers', () => {
  it('are notified when a request starts and ends, but not per streamed chunk', () => {
    stubCapture(true)
    const listener = vi.fn()
    const unsubscribe = subscribeToTranscripts(listener)

    const recorder = beginTranscript({ provider: 'mock', model: 'mock', label: 'Opening', messages })
    expect(listener).toHaveBeenCalledTimes(1)

    recorder.appendChunk('a')
    recorder.appendChunk('b')
    expect(listener).toHaveBeenCalledTimes(1)

    recorder.complete()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    clearTranscripts()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('export', () => {
  it('serializes every captured transcript as tagged JSON', () => {
    stubCapture(true)
    const recorder = beginTranscript({ provider: 'openai', model: 'gpt-5', label: 'Generation', messages })
    recorder.appendChunk('reply')
    recorder.complete()

    const parsed = JSON.parse(serializeTranscripts(getTranscripts(), '2026-07-30T00:00:00.000Z'))
    expect(parsed.format).toBe(TRANSCRIPT_EXPORT_FORMAT)
    expect(parsed.exportedAt).toBe('2026-07-30T00:00:00.000Z')
    expect(parsed.transcripts[0].messages[1].content).toBe('Write a script about falling')
    expect(parsed.transcripts[0].response).toBe('reply')
  })

  it('renders a readable text version with every message and the reply', () => {
    stubCapture(true)
    const recorder = beginTranscript({
      provider: 'openai',
      model: 'gpt-5',
      label: 'Opening',
      exampleIds: ['falling.md'],
      messages
    })
    recorder.appendChunk('reply')
    recorder.complete()

    const text = formatTranscriptsAsText(getTranscripts())
    expect(text).toContain('=== Opening (openai / gpt-5) ===')
    expect(text).toContain('examples: falling.md')
    expect(text).toContain('--- system ---')
    expect(text).toContain('## Example: Falling')
    expect(text).toContain('--- response ---\nreply')
  })
})

describe('message and example helpers', () => {
  it('names examples by id, falling back to filename', () => {
    expect(exampleIdsOf([
      { metadata: { id: 'abc' } },
      { metadata: { filename: 'falling.md' } },
      { metadata: {} }
    ])).toEqual(['abc', 'falling.md'])
    expect(exampleIdsOf(undefined)).toEqual([])
  })

  it('stringifies non-string message content rather than dropping it', () => {
    expect(toTranscriptMessages([
      { role: 'user', content: 'plain' },
      { role: 'user', content: [{ type: 'text', text: 'part' }] },
      { role: 'assistant' }
    ])).toEqual([
      { role: 'user', content: 'plain' },
      { role: 'user', content: '[{"type":"text","text":"part"}]' },
      { role: 'assistant', content: '' }
    ])
  })
})
