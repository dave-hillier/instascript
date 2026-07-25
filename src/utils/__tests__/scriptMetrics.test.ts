import { describe, it, expect } from 'vitest'
import { countWords, formatScriptLength, extractDocumentTitle } from '../scriptMetrics'

describe('countWords', () => {
  it('counts words separated by single spaces', () => {
    expect(countWords('take a slow breath in')).toBe(5)
  })

  it('treats runs of whitespace and newlines as single separators', () => {
    expect(countWords('  drift\n\ndeeper   now\t\trelax  ')).toBe(4)
  })

  it('returns zero for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   \n \t ')).toBe(0)
  })
})

describe('formatScriptLength', () => {
  it('formats a long script with a thousands separator and rounded minutes', () => {
    expect(formatScriptLength(2140)).toBe('2,140 words · ~16 min')
  })

  it('rounds to the nearest minute at 130 words per minute', () => {
    expect(formatScriptLength(130)).toBe('130 words · ~1 min')
    expect(formatScriptLength(260)).toBe('260 words · ~2 min')
    expect(formatScriptLength(325)).toBe('325 words · ~3 min')
  })

  it('never reports less than one minute', () => {
    expect(formatScriptLength(40)).toBe('40 words · ~1 min')
  })

  it('uses the singular form for a single word', () => {
    expect(formatScriptLength(1)).toBe('1 word · ~1 min')
  })
})

describe('extractDocumentTitle', () => {
  it('extracts the title from a level-one heading on the first line', () => {
    expect(extractDocumentTitle('# Deep Rest\n\n## Induction\nBreathe...')).toBe('Deep Rest')
  })

  it('ignores leading whitespace before the heading', () => {
    expect(extractDocumentTitle('\n\n  # Quiet Descent\n## Deepener')).toBe('Quiet Descent')
  })

  it('returns null when the document starts with a section heading', () => {
    expect(extractDocumentTitle('## Induction\nBreathe in slowly')).toBeNull()
  })

  it('returns null for empty or untitled content', () => {
    expect(extractDocumentTitle('')).toBeNull()
    expect(extractDocumentTitle('Just some prose with no heading')).toBeNull()
  })

  it('trims trailing whitespace from the extracted title', () => {
    expect(extractDocumentTitle('# Spaced Out   \ncontent')).toBe('Spaced Out')
  })
})
