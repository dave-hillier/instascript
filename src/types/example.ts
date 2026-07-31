// What a section of an example is for, as decided when the example was split
// out of a transcript. Only the pair the markdown body cannot carry is stored:
// slug, path, order and word count are derived from the body by exampleFs, the
// same way the script filesystem derives them from an outline.
export interface ExampleSectionSpec {
  title: string
  prompt: string
}

export interface ExampleRecord {
  id: string
  title: string
  tags: string[]
  content: string
  source: 'bundled' | 'user'
  // Which folder the example is filed under. Absent means unfiled — the
  // folder every example imported before folders existed belongs to.
  folder?: string
  createdAt?: number
  embedding?: number[]
  // The library script this example was saved from, when it came from one.
  // It is what lets the corpus say an example is already held for a script,
  // so saving the same script twice is offered as a replacement rather than
  // quietly making a duplicate.
  sourceScriptId?: string
  // Present on examples imported from a transcript, absent on everything else
  sections?: ExampleSectionSpec[]
}
