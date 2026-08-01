export interface ExampleRecord {
  id: string
  title: string
  tags: string[]
  // Which group the example belongs to. Groups are switched on and off as a
  // unit, so a group is the lever for choosing the style generation imitates:
  // a folder of long-form hypnosis scripts and a folder of short meditations
  // stay separable instead of blending into one corpus.
  group: string
  content: string
  source: 'bundled' | 'user'
  createdAt?: number
  embedding?: number[]
}

// A group and what it holds, for display and for the enable/disable controls
export interface ExampleGroupSummary {
  name: string
  count: number
  enabled: boolean
  // Bundled groups are read-only: their examples cannot be regrouped or deleted
  readOnly: boolean
}
