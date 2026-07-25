export interface ExampleRecord {
  id: string
  title: string
  tags: string[]
  content: string
  source: 'bundled' | 'user'
  createdAt?: number
  embedding?: number[]
}
