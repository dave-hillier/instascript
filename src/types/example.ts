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
}
