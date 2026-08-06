import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getJobInstructions, setJobInstructions } from '../config'
import {
  appendStandingInstructions,
  buildDirectAddressPrompt,
  buildExampleTaggingPrompt,
  buildImportFormattingPrompt,
  buildStyleCritiquePrompt,
  getSystemPrompt
} from '../prompts'

// The settings live in localStorage, and prompts read them as each request is
// built, so these tests need a store to write into. A map is enough: only
// getItem and setItem are ever reached.
const store = new Map<string, string>()

const fakeLocalStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) }
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', { localStorage: fakeLocalStorage })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('standing instruction settings', () => {
  it('is empty until something is saved', () => {
    expect(getJobInstructions('style')).toBe('')
    expect(getJobInstructions('import')).toBe('')
  })

  it('round-trips each job separately', () => {
    setJobInstructions('style', 'British spelling throughout')
    setJobInstructions('import', 'Tag by the trigger the script installs')

    expect(getJobInstructions('style')).toBe('British spelling throughout')
    expect(getJobInstructions('import')).toBe('Tag by the trigger the script installs')
  })

  it('treats a whitespace-only instruction as unset', () => {
    setJobInstructions('style', '   \n  ')

    expect(getJobInstructions('style')).toBe('')
  })

  it('falls back to empty rather than throwing without storage', () => {
    vi.unstubAllGlobals()

    expect(getJobInstructions('style')).toBe('')
    expect(() => setJobInstructions('style', 'anything')).not.toThrow()
  })
})

describe('appendStandingInstructions', () => {
  it('leaves the prompt exactly as it was when there is nothing to add', () => {
    expect(appendStandingInstructions('Base prompt.', '', 'Preamble.')).toBe('Base prompt.')
    expect(appendStandingInstructions('Base prompt.', '  \n ', 'Preamble.')).toBe('Base prompt.')
  })

  it('appends the block last, under a heading, with the preamble', () => {
    const prompt = appendStandingInstructions('Base prompt.', 'Keep it slow.', 'Preamble.')

    expect(prompt.startsWith('Base prompt.')).toBe(true)
    expect(prompt).toContain('## Standing instructions')
    expect(prompt).toContain('Preamble.')
    expect(prompt.endsWith('Keep it slow.')).toBe(true)
  })
})

describe('standing instructions in the prompts', () => {
  it('carries the style instructions in the system prompt every request shares', () => {
    const before = getSystemPrompt()
    setJobInstructions('style', 'Never count the listener down')

    const after = getSystemPrompt()
    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain('Never count the listener down')
  })

  it('holds the style-review pass to the same instructions', () => {
    setJobInstructions('style', 'Never count the listener down')

    expect(buildStyleCritiquePrompt('# Script\n\n## Induction\nBreathe.'))
      .toContain('Never count the listener down')
  })

  it('carries the import instructions in each of the import jobs', () => {
    setJobInstructions('import', 'Keep the original headings verbatim')

    expect(buildImportFormattingPrompt('Deep Rest')).toContain('Keep the original headings verbatim')
    expect(buildExampleTaggingPrompt(['sleep'])).toContain('Keep the original headings verbatim')
    expect(buildDirectAddressPrompt()).toContain('Keep the original headings verbatim')
  })

  it('keeps the two jobs apart, so neither leaks into the other', () => {
    setJobInstructions('style', 'A style note')
    setJobInstructions('import', 'An import note')

    expect(getSystemPrompt()).not.toContain('An import note')
    expect(buildImportFormattingPrompt('Deep Rest')).not.toContain('A style note')
  })

  it('adds nothing at all while both are unset', () => {
    for (const prompt of [
      getSystemPrompt(),
      buildStyleCritiquePrompt('# Script'),
      buildImportFormattingPrompt('Deep Rest'),
      buildExampleTaggingPrompt([]),
      buildDirectAddressPrompt()
    ]) {
      expect(prompt).not.toContain('## Standing instructions')
    }
  })

  it('sends the user\'s words through verbatim, placeholders and all', () => {
    // Substitution runs on the template before the block is appended, so
    // brace-shaped text and regex replacement patterns survive as written
    const instructions = 'Use {title} literally, and $& and $1 as well'
    setJobInstructions('style', instructions)
    setJobInstructions('import', instructions)

    expect(getSystemPrompt()).toContain(instructions)
    expect(buildImportFormattingPrompt('Deep Rest')).toContain(instructions)
  })
})
