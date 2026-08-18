// The utility model role: short, non-streaming requests that support the app
// rather than write the script — suggesting tags for an imported example,
// tidying a plain-text import into markdown. Kept deliberately separate from
// ScriptGenerationService: nothing here streams, nothing here carries the
// hypnosis system prompt or the example corpus, and the model behind it is
// the small cheap one chosen in settings.

export type UtilityJob =
  | 'tagging'
  | 'formatting'
  | 'voicing'
  | 'transcript'
  | 'sectioning'
  | 'retitling'
  // Reading one example for the devices it uses, and consolidating what a
  // whole folder's readings have in common (story 8.20)
  | 'devices'
  | 'deviceDigest'
  // Reading the consolidated devices for the words in them that belong to
  // this collection alone, and how each is said without them (story 8.21)
  | 'deviceGeneric'

export interface UtilityCompletionRequest {
  job: UtilityJob
  system: string
  user: string
  // Cap on the reply. Left generous by default: reasoning models spend part
  // of their budget before emitting a token, and a truncated reply is worse
  // than a slightly more expensive one.
  maxOutputTokens?: number
  signal?: AbortSignal
}

export interface UtilityModelService {
  // The model actually being used, for display and for transcripts
  readonly model: string
  // Whether the service can reach a real model. False for the mock, so
  // callers can skip work rather than store invented results.
  readonly isLive: boolean
  complete(request: UtilityCompletionRequest): Promise<string>
}

// What each job is called in the debug transcript
export const UTILITY_JOB_LABELS: Record<UtilityJob, string> = {
  tagging: 'Tagging',
  formatting: 'Markdown formatting',
  voicing: 'Direct address',
  transcript: 'Transcript split',
  sectioning: 'Sectioning',
  retitling: 'Retitling',
  devices: 'Device extraction',
  deviceDigest: 'Device consolidation',
  deviceGeneric: 'Device generalisation'
}
