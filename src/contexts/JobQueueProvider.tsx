import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Job, JobQueueState, JobQueueAction } from '../types/job'
import { JobCoordinator } from '../services/jobCoordinator'
import { JobQueueContext } from './JobQueueContext'
import type { JobQueueContextType } from './JobQueueContext'
import { Logger } from '../utils/logger'

const jobQueueReducer = (state: JobQueueState, action: JobQueueAction): JobQueueState => {
  switch (action.type) {
    case 'LOAD_JOBS':
      return { ...state, jobs: action.jobs }
    
    case 'ADD_JOB':
      return { 
        ...state, 
        jobs: [...state.jobs, action.job] 
      }
    
    case 'UPDATE_JOB':
      return {
        ...state,
        jobs: state.jobs.map(job =>
          job.id === action.jobId
            ? { ...job, ...action.updates, updatedAt: Date.now() } as Job
            : job
        )
      }
    
    case 'REMOVE_JOB':
      return {
        ...state,
        jobs: state.jobs.filter(job => job.id !== action.jobId)
      }
    
    case 'SET_ACTIVE_JOB':
      return { ...state, activeJobId: action.jobId }
    
    case 'SET_PROCESSING':
      return { ...state, isProcessing: action.isProcessing }
    
    case 'CLEAR_COMPLETED_JOBS':
      return {
        ...state,
        jobs: state.jobs.filter(job => 
          job.status !== 'completed' && job.status !== 'failed'
        )
      }
    
    default:
      return state
  }
}

type JobQueueProviderProps = {
  children: ReactNode
}

export const JobQueueProvider = ({ children }: JobQueueProviderProps) => {
  const [state, dispatch] = useReducer(jobQueueReducer, {
    jobs: [],
    activeJobId: null,
    isProcessing: false
  })
  
  const [isLeader, setIsLeader] = useState(false)
  const coordinatorRef = useRef<JobCoordinator | null>(null)

  // Initialize job coordinator
  useEffect(() => {
    const coordinator = new JobCoordinator()
    coordinatorRef.current = coordinator
    
    // Handle job updates from coordinator
    coordinator.onJobsUpdate((jobs: Job[]) => {
      dispatch({ type: 'LOAD_JOBS', jobs })
    })
    
    // Handle leadership changes
    coordinator.onLeadershipChange((leaderStatus: boolean) => {
      setIsLeader(leaderStatus)
      Logger.log('JobQueueProvider', `Leadership changed: ${leaderStatus ? 'leader' : 'follower'}`)
    })
    
    // Load initial jobs
    const initialJobs = coordinator.getJobs()
    dispatch({ type: 'LOAD_JOBS', jobs: initialJobs })
    
    // Check for pending jobs on app load
    const pendingJobs = initialJobs.filter(job => 
      job.status === 'queued' || job.status === 'processing'
    )
    if (pendingJobs.length > 0) {
      Logger.log('JobQueueProvider', `Found ${pendingJobs.length} pending job(s) on app load`)
    }
    
    return () => {
      coordinator.destroy()
    }
  }, [])


  const addJob = useCallback((jobData: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'status'>) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) {
      Logger.error('JobQueueProvider', 'No coordinator available')
      return
    }
    
    const job: Job = {
      ...jobData,
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as Job
    
    coordinator.addJob(job)
    Logger.log('JobQueueProvider', `Added job: ${job.type} for script ${job.scriptId}`)
  }, [])

  const updateJob = useCallback((jobId: string, updates: Partial<Job>) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    coordinator.updateJob(jobId, updates)
  }, [])

  const removeJob = useCallback((jobId: string) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    coordinator.removeJob(jobId)
  }, [])

  const retryJob = useCallback((jobId: string) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    coordinator.updateJob(jobId, { 
      status: 'queued', 
      error: undefined,
      updatedAt: Date.now()
    })
  }, [])

  const clearCompletedJobs = useCallback(() => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    coordinator.clearCompletedJobs()
  }, [])

  const contextValue: JobQueueContextType = {
    state,
    addJob,
    updateJob,
    removeJob,
    retryJob,
    clearCompletedJobs,
    isLeader
  }

  return (
    <JobQueueContext.Provider value={contextValue}>
      {children}
    </JobQueueContext.Provider>
  )
}