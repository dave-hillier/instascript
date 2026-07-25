import { describe, it, expect } from 'vitest'
import { tokenizeScriptLine } from '../scriptLineTokens'

describe('tokenizeScriptLine', () => {
  it('returns a single text token for plain prose', () => {
    expect(tokenizeScriptLine('Let your shoulders soften.')).toEqual([
      { kind: 'text', text: 'Let your shoulders soften.' }
    ])
  })

  it('returns no tokens for an empty line', () => {
    expect(tokenizeScriptLine('')).toEqual([])
  })

  it('marks ellipsis pacing marks', () => {
    expect(tokenizeScriptLine('Breathe in… and out')).toEqual([
      { kind: 'text', text: 'Breathe in' },
      { kind: 'pacing', text: '…' },
      { kind: 'text', text: ' and out' }
    ])
  })

  it('marks the long-dash pacing mark', () => {
    expect(tokenizeScriptLine('deeper ⏤ and deeper')).toEqual([
      { kind: 'text', text: 'deeper ' },
      { kind: 'pacing', text: '⏤' },
      { kind: 'text', text: ' and deeper' }
    ])
  })

  it('groups consecutive pacing marks into one token', () => {
    expect(tokenizeScriptLine('down…… now')).toEqual([
      { kind: 'text', text: 'down' },
      { kind: 'pacing', text: '……' },
      { kind: 'text', text: ' now' }
    ])
  })

  it('treats a literal three-dot ellipsis as pacing', () => {
    expect(tokenizeScriptLine('rest... rest')).toEqual([
      { kind: 'text', text: 'rest' },
      { kind: 'pacing', text: '...' },
      { kind: 'text', text: ' rest' }
    ])
  })

  it('marks bracketed stage directions', () => {
    expect(tokenizeScriptLine('[pause for three breaths] Continue.')).toEqual([
      { kind: 'direction', text: '[pause for three breaths]' },
      { kind: 'text', text: ' Continue.' }
    ])
  })

  it('handles a line that is only a stage direction', () => {
    expect(tokenizeScriptLine('[long pause]')).toEqual([
      { kind: 'direction', text: '[long pause]' }
    ])
  })

  it('handles mixed pacing marks and directions in one line', () => {
    expect(tokenizeScriptLine('Sink… [softly] deeper ⏤ still.')).toEqual([
      { kind: 'text', text: 'Sink' },
      { kind: 'pacing', text: '…' },
      { kind: 'text', text: ' ' },
      { kind: 'direction', text: '[softly]' },
      { kind: 'text', text: ' deeper ' },
      { kind: 'pacing', text: '⏤' },
      { kind: 'text', text: ' still.' }
    ])
  })

  it('round-trips: concatenated token text equals the input line', () => {
    const line = 'And now… [whisper] let go ⏤ completely... gone.'
    const joined = tokenizeScriptLine(line).map(token => token.text).join('')
    expect(joined).toBe(line)
  })
})
