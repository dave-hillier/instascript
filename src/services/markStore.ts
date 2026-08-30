// The reader's own marks, and the model's findings the reader has put away.
//
// These are NOT part of the conversation. A model's finding belongs to the run
// — it is a judgement the model made, in the log, and it travels with the
// conversation through export, import and duplication. A reader's flag is a
// note about the words in front of them right now: it says nothing about how
// the script was written, it is nobody else's business, and writing it into
// the conversation file would put an opinion into a record that is supposed to
// hold what actually happened.
//
// So flags live in localStorage, keyed by script id, and nowhere else. A
// duplicated script gets a new id and therefore starts clean, which is the
// behaviour we want anyway: a mark is about a body, and the duplicate's bodies
// are about to diverge from the ones the marks were pinned to.
//
// Every read is defensive. Storage is user-editable, survives a build that
// changes these shapes, and is shared with whatever the browser did to it in
// between; a malformed entry is dropped rather than rendered or thrown over.

import type { SpanAnchor } from './span'
import type { CritiqueFinding, CritiqueRecord } from '../types/conversation'

// Bumped only if a stored flag's shape changes incompatibly. A record written
// under a different version is discarded rather than migrated: a flag is cheap
// to re-make and expensive to get subtly wrong.
export const MARKS_STORAGE_VERSION = 1

// One passage the reader marked, in their own words.
export interface ReaderFlag {
  id: string
  // Title of the section the passage is in, which is how a mark finds its body
  // again — the projection keys sections by title.
  section: string
  // Where the passage sits, recorded exactly as a model's span is: quote,
  // surrounding words, and which occurrence. Never an offset.
  anchor: SpanAnchor
  // The section's replacement count when the passage was pinned. Comparing it
  // against the count now is what separates a passage the writer rewrote from
  // one that was never touched.
  revisions: number
  // The reader's label for it. Theirs to change, unlike a finding's.
  label: string
  // A longer note, when they wrote one.
  note?: string
  createdAt: number
}

// Everything the browser remembers for one script.
export interface ReaderMarks {
  flags: ReaderFlag[]
  // Keys of the model findings the reader has dismissed. Dismissing hides a
  // finding here; it does not touch the conversation, because the model did
  // make that finding and the log has to keep saying so.
  dismissed: string[]
  // Keys of the findings the reader PAID a rewrite for. Held apart from the
  // dismissed ones because the two are not the same act: a dismissal is "not
  // this, thanks" and can be taken back, while a spend already sent an
  // instruction and replaced the body the finding quoted. Offering to restore
  // it would offer to re-buy a rewrite that has already happened.
  spent: string[]
}

export const NO_MARKS: ReaderMarks = { flags: [], dismissed: [], spent: [] }

// Separates the parts of a finding key. A unit separator cannot appear in a
// section title or a reason the model wrote, so two findings can never be
// joined into the same key by where their text happens to end.
const KEY_SEPARATOR = '\u001F'

// A finding's identity, stable across reloads and across a body being
// rewritten under it.
//
// It is built from what the RECORD says rather than from where the passage
// currently sits: stage, section, reason and the first quote are all fixed at
// the moment the critique was accepted, so a dismissal survives the section
// being rewritten, which is exactly what a reader who dismissed a finding
// meant. Findings are few — six per critique at most — so a collision between
// two findings identical in all four fields would be two indistinguishable
// findings, and dismissing both together is the right answer anyway.
export function findingKey(
  finding: Pick<CritiqueFinding, 'section' | 'reason' | 'spans'>,
  stage: CritiqueRecord['stage']
): string {
  const quote = finding.spans?.[0]?.quote ?? ''
  return [stage, finding.section, finding.reason, quote].join(KEY_SEPARATOR)
}

const KEY_PREFIX = 'marks.'

const storageKey = (scriptId: string): string => `${KEY_PREFIX}${scriptId}`

const isAnchor = (value: unknown): value is SpanAnchor => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.quote === 'string' && candidate.quote !== '' &&
    typeof candidate.before === 'string' &&
    typeof candidate.after === 'string' &&
    typeof candidate.occurrence === 'number' &&
    Number.isInteger(candidate.occurrence) &&
    candidate.occurrence >= 0
}

// A stored flag is admitted field by field, and rebuilt rather than passed
// through, so nothing a hand-edited file carries reaches the view model.
const readFlag = (value: unknown): ReaderFlag | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id === '') return null
  if (typeof candidate.section !== 'string' || candidate.section === '') return null
  if (!isAnchor(candidate.anchor)) return null
  if (typeof candidate.label !== 'string') return null
  const revisions = typeof candidate.revisions === 'number' && Number.isFinite(candidate.revisions)
    ? candidate.revisions
    : 0
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : 0
  const anchor = candidate.anchor
  return {
    id: candidate.id,
    section: candidate.section,
    anchor: {
      quote: anchor.quote,
      before: anchor.before,
      after: anchor.after,
      occurrence: anchor.occurrence
    },
    revisions,
    label: candidate.label,
    ...(typeof candidate.note === 'string' && candidate.note !== '' ? { note: candidate.note } : {}),
    createdAt
  }
}

// A stored list of finding keys. A record written before spending was held
// apart from dismissal has no `spent` at all, which reads as none rather than
// as a reason to discard the reader's flags.
const readKeys = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []

// What the browser holds for a script, or nothing at all.
//
// Absent storage is not an error: the tests run in node, and a browser can
// refuse storage outright in a private window. Both answer the same way a
// script with no marks does.
export function loadMarks(scriptId: string): ReaderMarks {
  if (typeof window === 'undefined') return NO_MARKS
  try {
    const item = window.localStorage.getItem(storageKey(scriptId))
    if (!item) return NO_MARKS
    const parsed: unknown = JSON.parse(item)
    if (typeof parsed !== 'object' || parsed === null) return NO_MARKS
    const record = parsed as Record<string, unknown>
    if (record.version !== MARKS_STORAGE_VERSION) return NO_MARKS
    const flags = Array.isArray(record.flags)
      ? record.flags.map(readFlag).filter((flag): flag is ReaderFlag => flag !== null)
      : []
    return { flags, dismissed: readKeys(record.dismissed), spent: readKeys(record.spent) }
  } catch (error) {
    console.warn(`Error loading marks for ${scriptId} from localStorage:`, error)
    return NO_MARKS
  }
}

// Nothing marked is stored as nothing at all rather than as an empty record,
// so a reader who clears their marks leaves no key behind for the next build
// to interpret.
export function saveMarks(scriptId: string, marks: ReaderMarks): void {
  if (typeof window === 'undefined') return
  try {
    if (marks.flags.length === 0 && marks.dismissed.length === 0 && marks.spent.length === 0) {
      window.localStorage.removeItem(storageKey(scriptId))
      return
    }
    window.localStorage.setItem(
      storageKey(scriptId),
      JSON.stringify({
        version: MARKS_STORAGE_VERSION,
        flags: marks.flags,
        dismissed: marks.dismissed,
        spent: marks.spent
      })
    )
  } catch (error) {
    console.warn(`Error saving marks for ${scriptId} to localStorage:`, error)
  }
}

// Forget everything remembered for scripts that are no longer in the library.
//
// Marks are keyed by script id and nothing else refers to them, so a deleted
// script leaves its key behind forever unless something goes looking. The
// library is the authority on which scripts exist; anything under the marks
// prefix that names a script it does not list is a leftover.
//
// Returns the ids it forgot, so a caller can say what it did. Storage is
// enumerated through the Storage API rather than Object.keys so a browser that
// exposes only the API still prunes.
export function pruneMarks(keptScriptIds: readonly string[]): string[] {
  if (typeof window === 'undefined') return []
  const kept = new Set(keptScriptIds)
  try {
    const storage = window.localStorage
    const stale: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key === null || !key.startsWith(KEY_PREFIX)) continue
      const scriptId = key.slice(KEY_PREFIX.length)
      if (!kept.has(scriptId)) stale.push(scriptId)
    }
    // Removed after the walk rather than during it: removing a key while
    // enumerating by index moves every key after it down one.
    for (const scriptId of stale) storage.removeItem(storageKey(scriptId))
    return stale
  } catch (error) {
    console.warn('Error pruning marks from localStorage:', error)
    return []
  }
}

// The reader's selection, as text.
//
// This is the one place the feature reads the DOM, and it reads it rather than
// changing it: there is no other way to learn what somebody selected. The root
// element is handed in by the section body's own handler as `currentTarget` —
// never looked up by id — so the function cannot reach outside the element
// that invoked it, and a selection that started in the conversation panel and
// ended in the script is refused rather than pinned to words it does not name.
//
// What comes back is text, not offsets. The text is then resolved against the
// section's body with resolveSpan, exactly as a model's quoted passage is, so
// the reader and the model are held to the same rule about what a passage is:
// long enough to be worth naming, and unique in the body.
export function readBodySelection(root: HTMLElement): string | null {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const text = selection.toString()
  return text.trim() === '' ? null : text
}
