import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Job, JobQueueState, JobQueueAction } from '../types/job'
import { JobCoordinator } from '../services/jobCoordinator'
import { JobQueueContext } from './JobQueueContext'
import type { JobQueueContextType } from './JobQueueContext'
import { messageBus } from '../services/messageBus'
import type { MessageSubscription } from '../services/messageBus'

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
  const messageSubscriptionsRef = useRef<MessageSubscription[]>([])

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
      console.log(`Leadership changed: ${leaderStatus ? 'leader' : 'follower'}`)
    })
    
    // Load initial jobs
    const initialJobs = coordinator.getJobs()
    dispatch({ type: 'LOAD_JOBS', jobs: initialJobs })
    
    // Check for pending jobs on app load
    const pendingJobs = initialJobs.filter(job => 
      job.status === 'queued' || job.status === 'processing'
    )
    if (pendingJobs.length > 0) {
      console.log(`Found ${pendingJobs.length} pending job(s) on app load`)
    }
    
    return () => {
      coordinator.destroy()
      // Clean up message subscriptions
      messageSubscriptionsRef.current.forEach(sub => sub.unsubscribe())
    }
  }, [])

  // Setup message bus subscriptions for job status notifications
  useEffect(() => {
    const subscriptions = [
      // Listen for job updates to notify other parts of the system
      messageBus.subscribe('JOB_STATUS_CHANGED', (payload) => {
        console.log('Job status changed via message bus', payload)
      })
    ]
    
    messageSubscriptionsRef.current = subscriptions
    
    return () => {
      subscriptions.forEach(sub => sub.unsubscribe())
    }
  }, [])


  const addJob = useCallback((jobData: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'status'>) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) {
      console.error('No coordinator available')
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
    console.log(`Added job: ${job.type} for script ${job.scriptId}`)
    
    // Notify via message bus
    messageBus.publish('JOB_STATUS_CHANGED', {
      jobId: job.id,
      status: 'queued',
      type: job.type
    })
  }, [])

  const updateJob = useCallback((jobId: string, updates: Partial<Job>) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    coordinator.updateJob(jobId, updates)
    
    // Notify via message bus if status changed
    if (updates.status) {
      const job = coordinator.getJobs().find(j => j.id === jobId)
      if (job) {
        messageBus.publish('JOB_STATUS_CHANGED', {
          jobId,
          status: updates.status,
          type: job.type
        })
      }
    }
  }, [])

  const removeJob = useCallback((jobId: string) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    
    const job = coordinator.getJobs().find(j => j.id === jobId)
    coordinator.removeJob(jobId)
    
    // Notify via message bus
    if (job) {
      messageBus.publish('JOB_STATUS_CHANGED', {
        jobId,
        status: 'removed',
        type: job.type
      })
    }
  }, [])

  const retryJob = useCallback((jobId: string) => {
    const coordinator = coordinatorRef.current
    if (!coordinator) return
    
    const job = coordinator.getJobs().find(j => j.id === jobId)
    coordinator.updateJob(jobId, { 
      status: 'queued', 
      error: undefined,
      updatedAt: Date.now()
    })
    
    // Notify via message bus
    if (job) {
      messageBus.publish('JOB_STATUS_CHANGED', {
        jobId,
        status: 'queued',
        type: job.type
      })
    }
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