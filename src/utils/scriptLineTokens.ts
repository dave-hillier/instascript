// Splits a line of script prose into tokens so the reading view can visually
// distinguish pacing marks (… and ⏤, or a literal "...") and [bracketed stage
// directions] from spoken text.

export type ScriptLineTokenKind = 'text' | 'pacing' | 'direction'

export interface ScriptLineToken {
  kind: ScriptLineTokenKind
  text: string
}

const TOKEN_PATTERN = /(\[[^\]]*\]|[…⏤]+|\.{3,})/g

export function tokenizeScriptLine(line: string): ScriptLineToken[] {
  const tokens: ScriptLineToken[] = []
  let lastIndex = 0

  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ kind: 'text', text: line.slice(lastIndex, index) })
    }
    const text = match[0]
    tokens.push({ kind: text.startsWith('[') ? 'direction' : 'pacing', text })
    lastIndex = index + text.length
  }

  if (lastIndex < line.length) {
    tokens.push({ kind: 'text', text: line.slice(lastIndex) })
  }

  return tokens
}
