// Rows for the per-section word-count meter. The outline is the plan and the
// document is what actually exists, and the two drift apart the moment the
// script changes structurally — a manual edit that splits a section in two, a
// refinement that adds one, a rename. Showing the plan alone hides that work;
// showing the document alone hides what is still to come during a run. The
// meter therefore reads from both: every written section, in document order,
// with planned-but-unwritten sections slotted in at their planned position.

export interface ProgressSection {
  title: string
  wordCount: number
}

export interface ProgressPlan {
  phase: string
  currentSectionIndex: number
  outline: { sections: { title: string }[] } | null
}

export type ProgressRowState = 'complete' | 'active' | 'pending' | 'empty'

export interface ProgressRow {
  title: string
  wordCount: number
  state: ProgressRowState
}

export function buildProgressRows(
  sections: ProgressSection[],
  plan: ProgressPlan | null
): ProgressRow[] {
  const plannedTitles = plan?.outline?.sections.map(section => section.title) ?? []
  const isGenerating = plan?.phase === 'generating_section'
  // The section being written right now, named rather than numbered: an added
  // or renamed section shifts every index after it, but not the title
  const activeTitle = isGenerating
    ? plannedTitles[plan?.currentSectionIndex ?? -1]
    : undefined

  const rows: ProgressRow[] = sections.map(section => ({
    title: section.title,
    wordCount: section.wordCount,
    state: section.title === activeTitle
      ? 'active'
      : section.wordCount === 0 ? 'empty' : 'complete'
  }))

  // Planned sections with nothing written yet follow the planned section before
  // them, so a run reads top to bottom even before the later sections exist —
  // and sections written outside the plan keep the position they hold in the
  // document rather than displacing what is still to come
  let anchor = -1
  plannedTitles.forEach((title, plannedIndex) => {
    const existing = rows.findIndex(row => row.title === title)
    if (existing >= 0) {
      anchor = existing
      return
    }
    const state: ProgressRowState = title === activeTitle
      ? 'active'
      : isGenerating && plannedIndex > (plan?.currentSectionIndex ?? 0) ? 'pending' : 'empty'
    anchor += 1
    rows.splice(anchor, 0, { title, wordCount: 0, state })
  })

  return rows
}
