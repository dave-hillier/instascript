export interface Script {
  id: string
  title: string
  content: string
  createdAt: string
  isArchived: boolean
  tags?: string[]
  status?: 'draft' | 'complete' | 'in-progress'
  length?: string
  comments?: number
}