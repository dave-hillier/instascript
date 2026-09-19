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
  // The provider and model this script was started on. The model is the run's
  // pin: a generation reads it rather than the live setting, so changing the
  // generation model halfway through cannot leave the second half of a script
  // being written by a different model — which, once the writing is done with
  // tool calls, decides whether those requests can be served at all.
  provider?: string
  model?: string
  // The corpus example this script was opened from, when it came from one.
  // The script is a copy from that moment on — editing it never writes back
  // to the example — but the link says where it came from.
  sourceExampleId?: string
}