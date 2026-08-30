// The reader's marks as state: what has been flagged, what has been relabelled
// or annotated, and which of the model's findings have been put away.
//
// It is a reducer rather than a handful of setters because the events are the
// interesting part. "The reader flagged a passage" and "the reader spent a
// flag on a rewrite" both remove nothing and add nothing in the same way, but
// they are not the same thing to anyone reading this later, and the page has to
// do something different after each. Naming them apart is what makes that
// readable.
//
// The script id lives in the state so a save can never be misfiled. Marks are
// loaded when the page opens a script and saved whenever the state changes; if
// the id were held separately, a navigation that changed it between the two
// would write one script's flags under another's name.

import type { ReaderFlag, ReaderMarks } from '../services/markStore'

export interface MarkState extends ReaderMarks {
  // The script these marks belong to, or null before any have been loaded.
  scriptId: string | null
}

export const NO_MARK_STATE: MarkState = { scriptId: null, flags: [], dismissed: [], spent: [] }

export type MarkEvent =
  // The stored marks for a script arrived, or the reader opened another script
  | { type: 'MARKS_LOADED'; scriptId: string; marks: ReaderMarks }
  // The reader selected a passage and marked it
  | { type: 'PASSAGE_FLAGGED'; flag: ReaderFlag }
  // A flag is the reader's own, so its label is theirs to change. A finding's
  // is not, which is why there is no event for that.
  | { type: 'FLAG_RELABELLED'; id: string; label: string }
  | { type: 'FLAG_ANNOTATED'; id: string; note: string }
  // The reader is done with a mark and changed nothing about the script
  | { type: 'FLAG_DISMISSED'; id: string }
  | { type: 'FINDING_DISMISSED'; key: string }
  // A dismissed finding brought back into view. There is no counterpart for a
  // flag: dismissing a flag discards it, because it was only ever the reader's
  // own note and there is nothing left to restore it from.
  | { type: 'FINDING_RESTORED'; key: string }
  // The mark was spent on a rewrite of the section it names. The passage it
  // pointed at is about to be replaced, so the mark goes with it rather than
  // hanging over words nobody has written yet (M4).
  | { type: 'FLAG_SPENT'; id: string }
  | { type: 'FINDING_SPENT'; key: string }
  // The findings the document now carries were read off it. Whatever the
  // reader dismissed or spent that is no longer among them is forgotten: a
  // key nothing can produce again hides nothing and offers nothing to
  // restore, and left alone the two lists only ever grow.
  | { type: 'FINDINGS_OBSERVED'; keys: readonly string[] }

const withoutFlag = (state: MarkState, id: string): MarkState =>
  state.flags.some(flag => flag.id === id)
    ? { ...state, flags: state.flags.filter(flag => flag.id !== id) }
    : state

const withDismissal = (state: MarkState, key: string): MarkState =>
  state.dismissed.includes(key)
    ? state
    : { ...state, dismissed: [...state.dismissed, key] }

// A spend is remembered apart from a dismissal. The reader paid a rewrite for
// this finding and the body it quoted has been replaced, so counting it under
// "Show N dismissed findings" would offer to restore a finding about words
// that are gone, and to buy the same rewrite twice.
const withSpend = (state: MarkState, key: string): MarkState =>
  state.spent.includes(key)
    ? state
    : { ...state, spent: [...state.spent, key] }

const kept = (keys: readonly string[], live: ReadonlySet<string>): string[] =>
  keys.filter(key => live.has(key))

// Every arm returns the state it was given when nothing changed, so a
// relabelling to the same words, or a dismissal of something already
// dismissed, does not look like a change to the effect that saves.
export const markReducer = (state: MarkState, event: MarkEvent): MarkState => {
  switch (event.type) {
    case 'MARKS_LOADED':
      return {
        scriptId: event.scriptId,
        flags: event.marks.flags,
        dismissed: event.marks.dismissed,
        spent: event.marks.spent
      }

    case 'PASSAGE_FLAGGED': {
      // The same passage marked twice is one mark, not two. Selecting a run of
      // words, clicking away and selecting them again is an ordinary thing to
      // do while reading, and it should not leave a pile of identical marks in
      // the panel; the passage is the identity, so quote and occurrence within
      // the section are what decide it.
      const alreadyFlagged = state.flags.some(flag =>
        flag.id === event.flag.id ||
        (flag.section === event.flag.section &&
          flag.anchor.quote === event.flag.anchor.quote &&
          flag.anchor.occurrence === event.flag.anchor.occurrence)
      )
      return alreadyFlagged ? state : { ...state, flags: [...state.flags, event.flag] }
    }

    case 'FLAG_RELABELLED': {
      // Rebuilt only when a flag actually changes. A relabelling to the words
      // already there, or against an id no longer in the list, would otherwise
      // hand back a new object and set the saving effect writing storage for
      // nothing.
      const flags = state.flags.map(flag =>
        flag.id === event.id && flag.label !== event.label
          ? { ...flag, label: event.label }
          : flag
      )
      return flags.every((flag, index) => flag === state.flags[index])
        ? state
        : { ...state, flags }
    }

    case 'FLAG_ANNOTATED': {
      // An emptied note is removed rather than stored as an empty string, so a
      // flag with nothing written on it reads the same however it got there.
      const flags = state.flags.map(flag => {
        if (flag.id !== event.id) return flag
        const note = event.note.trim()
        if (note === '') {
          if (flag.note === undefined) return flag
          // Rebuilt without the key rather than set to an empty string, so a
          // flag with nothing written on it reads the same however it got
          // there — and stores the same, since the key is optional.
          return {
            id: flag.id,
            section: flag.section,
            anchor: flag.anchor,
            revisions: flag.revisions,
            label: flag.label,
            createdAt: flag.createdAt
          }
        }
        return flag.note === note ? flag : { ...flag, note }
      })
      return flags.every((flag, index) => flag === state.flags[index])
        ? state
        : { ...state, flags }
    }

    case 'FLAG_DISMISSED':
    case 'FLAG_SPENT':
      return withoutFlag(state, event.id)

    case 'FINDING_DISMISSED':
      return withDismissal(state, event.key)

    case 'FINDING_SPENT':
      return withSpend(state, event.key)

    case 'FINDINGS_OBSERVED': {
      const live = new Set(event.keys)
      const dismissed = kept(state.dismissed, live)
      const spent = kept(state.spent, live)
      return dismissed.length === state.dismissed.length && spent.length === state.spent.length
        ? state
        : { ...state, dismissed, spent }
    }

    case 'FINDING_RESTORED':
      return state.dismissed.includes(event.key)
        ? { ...state, dismissed: state.dismissed.filter(key => key !== event.key) }
        : state

    default:
      return state
  }
}

// What the store should hold for this state, or nothing when no script has
// been loaded yet. Kept here so the page's saving effect has no decision of its
// own to make.
export const marksToStore = (state: MarkState): ReaderMarks =>
  ({ flags: state.flags, dismissed: state.dismissed, spent: state.spent })
