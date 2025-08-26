export type JobType = 'generate-script' | 'regenerate-section'

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export interface BaseJob {
  id: string
  type: JobType
  status: JobStatus
  createdAt: number
  updatedAt: number
  scriptId: string
  title: string
  error?: string
  progress?: number
}

export interface GenerateScriptJob extends BaseJob {
  type: 'generate-script'
  prompt: string
  conversationId?: string
}

export interface RegenerateSectionJob extends BaseJob {
  type: 'regenerate-section'
  sectionId: string
  sectionTitle: string
  conversationId: string
  prompt: string
}

export type Job = GenerateScriptJob | RegenerateSectionJob

export interface JobQueueState {
  jobs: Job[]
  activeJobId: string | null
  isProcessing: boolean
}

export type JobQueueAction = 
  | { type: 'ADD_JOB'; job: Job }
  | { type: 'UPDATE_JOB'; jobId: string; updates: Partial<Job> }
  | { type: 'REMOVE_JOB'; jobId: string }
  | { type: 'SET_ACTIVE_JOB'; jobId: string | null }
  | { type: 'SET_PROCESSING'; isProcessing: boolean }
  | { type: 'LOAD_JOBS'; jobs: Job[] }
  | { type: 'CLEAR_COMPLETED_JOBS' }

export interface JobQueueMessage {
  type: 'job-added' | 'job-updated' | 'job-completed' | 'job-failed' | 'queue-sync'
  jobId?: string
  job?: Job
  jobs?: Job[]
}

export interface JobCoordinatorOptions {
  maxConcurrentJobs?: number
  jobTimeout?: number
  retryAttempts?: number
}