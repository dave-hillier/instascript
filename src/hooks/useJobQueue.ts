import { useContext } from 'react'
import { JobQueueContext } from '../contexts/JobQueueContext'
import type { JobQueueContextType } from '../contexts/JobQueueContext'

export const useJobQueue = (): JobQueueContextType => {
  const context = useContext(JobQueueContext)
  if (context === undefined) {
    throw new Error('useJobQueue must be used within a JobQueueProvider')
  }
  return context
}