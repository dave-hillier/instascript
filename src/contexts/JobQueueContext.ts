import { createContext } from 'react'
import type { Job, JobQueueState } from '../types/job'

export interface JobQueueContextType {
  state: JobQueueState
  addJob: (job: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'status'>) => void
  updateJob: (jobId: string, updates: Partial<Job>) => void
  removeJob: (jobId: string) => void
  retryJob: (jobId: string) => void
  clearCompletedJobs: () => void
  cancelJob: (jobId: string) => void
  cancelJobsForScript: (scriptId: string) => void
  isLeader: boolean
}

export const JobQueueContext = createContext<JobQueueContextType | undefined>(undefined)