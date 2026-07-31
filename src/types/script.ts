export interface Script {
  id: string
  title: string
  content: string
  createdAt: string
  isArchived: boolean
  tags?: string[]
  status?: 'draft' | 'complete' | 'in-progress'
  length?: string
  conversationId?: string
  initialPrompt?: string
  // Spoken length in minutes requested when the script was created, so a
  // retry or a review judges against the same target
  targetMinutes?: number
  provider?: string
  model?: string
}