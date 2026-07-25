import type { ScriptOutline } from '../types/conversation'
import { parseOutline } from './conversationDocument'

// Story 8.9: the optional outline-critique step. One extra request checks the
// generated outline against the user's brief (coverage, escalation arc,
// section balance) before any section is written — the moment structural
// flaws are cheapest to fix. Pure logic for interpreting the critique
// response lives here; the prompt itself is built in prompts.ts from
// outline-critique.txt.

// Marker used as the RegenerationRequest section title for the critique
// request itself; real providers ignore it, and the mock uses it to return
// an outline-critique-shaped response.
export const OUTLINE_CRITIQUE_SECTION_TITLE = '__outline_critique__'

export interface OutlineCritiqueResult {
  // True when the critique approved the outline as-is (or produced nothing
  // usable, in which case the original outline is kept unchanged)
  approved: boolean
  revisedOutline: ScriptOutline | null
  revisedOutlineText: string | null
}

// Interprets the critique response: "OUTLINE OK" (or anything that does not
// contain a parseable outline) keeps the original outline; a response
// containing a full revised outline replaces it. Preamble before the
// "# Title" line from a less obedient model is tolerated.
export function parseOutlineCritiqueResponse(text: string): OutlineCritiqueResult {
  const keepOriginal: OutlineCritiqueResult = {
    approved: true,
    revisedOutline: null,
    revisedOutlineText: null
  }

  const trimmed = text.trim()
  if (/^OUTLINE OK\b/i.test(trimmed)) return keepOriginal

  const lines = trimmed.split('\n')
  const start = lines.findIndex(line => /^#\s/.test(line))
  if (start === -1) return keepOriginal

  const revisedOutlineText = lines.slice(start).join('\n').trim()
  const revisedOutline = parseOutline(revisedOutlineText)
  if (!revisedOutline) return keepOriginal

  return { approved: false, revisedOutline, revisedOutlineText }
}
