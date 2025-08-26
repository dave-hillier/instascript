import type { Job, JobQueueMessage, JobCoordinatorOptions } from '../types/job'
import { Logger } from '../utils/logger'

export class JobCoordinator {
  private channel: BroadcastChannel
  private isLeader: boolean = false
  private heartbeatInterval: number | null = null
  private leaderCheckInterval: number | null = null
  private onJobUpdate?: (jobs: Job[]) => void
  private onLeaderChange?: (isLeader: boolean) => void
  
  private readonly STORAGE_KEY = 'job-queue'
  private readonly LEADER_KEY = 'job-queue-leader'
  private readonly HEARTBEAT_INTERVAL = 2000
  private readonly LEADER_TIMEOUT = 5000

  constructor(
    _options: JobCoordinatorOptions = {}
  ) {
    this.channel = new BroadcastChannel('job-queue-channel')
    this.channel.addEventListener('message', this.handleMessage.bind(this))
    
    // Start leader election process
    this.startLeaderElection()
    
    Logger.log('JobCoordinator', 'Initialized')
  }

  private startLeaderElection(): void {
    // Check if there's already a leader
    const leaderInfo = this.getLeaderInfo()
    const now = Date.now()
    
    if (!leaderInfo || (now - leaderInfo.timestamp) > this.LEADER_TIMEOUT) {
      // No leader or leader is stale, become leader
      this.becomeLeader()
    } else {
      // There's an active leader, become follower
      this.becomeFollower()
    }
    
    // Start checking for leader health
    this.leaderCheckInterval = window.setInterval(() => {
      this.checkLeaderHealth()
    }, this.LEADER_TIMEOUT / 2)
  }

  private becomeLeader(): void {
    if (this.isLeader) return
    
    this.isLeader = true
    Logger.log('JobCoordinator', 'Became leader')
    
    // Set leader info in localStorage
    this.setLeaderInfo()
    
    // Start heartbeat
    this.heartbeatInterval = window.setInterval(() => {
      this.setLeaderInfo()
    }, this.HEARTBEAT_INTERVAL)
    
    // Notify about leader change
    this.onLeaderChange?.(true)
    
    // Broadcast that we're the new leader
    this.broadcast({ type: 'queue-sync', jobs: this.getJobs() })
  }

  private becomeFollower(): void {
    if (!this.isLeader) return
    
    this.isLeader = false
    Logger.log('JobCoordinator', 'Became follower')
    
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    
    // Notify about leader change
    this.onLeaderChange?.(false)
  }

  private checkLeaderHealth(): void {
    const leaderInfo = this.getLeaderInfo()
    const now = Date.now()
    
    if (!leaderInfo || (now - leaderInfo.timestamp) > this.LEADER_TIMEOUT) {
      if (!this.isLeader) {
        // Leader is dead, try to become leader
        this.becomeLeader()
      }
    }
  }

  private setLeaderInfo(): void {
    const leaderInfo = {
      timestamp: Date.now(),
      tabId: this.generateTabId()
    }
    localStorage.setItem(this.LEADER_KEY, JSON.stringify(leaderInfo))
  }

  private getLeaderInfo(): { timestamp: number; tabId: string } | null {
    try {
      const stored = localStorage.getItem(this.LEADER_KEY)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  }

  private generateTabId(): string {
    return `tab_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  private handleMessage(event: MessageEvent<JobQueueMessage>): void {
    const message = event.data
    Logger.log('JobCoordinator', 'Received message', { type: message.type, isLeader: this.isLeader })
    
    switch (message.type) {
      case 'queue-sync':
        if (message.jobs) {
          this.onJobUpdate?.(message.jobs)
        }
        break
      case 'job-added':
      case 'job-updated':
      case 'job-completed':
      case 'job-failed':
        // Sync jobs from storage
        this.syncJobs()
        break
    }
  }

  private broadcast(message: JobQueueMessage): void {
    this.channel.postMessage(message)
  }

  private syncJobs(): void {
    const jobs = this.getJobs()
    this.onJobUpdate?.(jobs)
  }

  // Public API
  addJob(job: Job): void {
    const jobs = this.getJobs()
    const updatedJobs = [...jobs, job]
    this.saveJobs(updatedJobs)
    
    // Immediately sync to local state
    this.onJobUpdate?.(updatedJobs)
    
    Logger.log('JobCoordinator', 'Job added', { jobId: job.id, type: job.type })
    this.broadcast({ type: 'job-added', jobId: job.id, job })
  }

  updateJob(jobId: string, updates: Partial<Job>): void {
    const jobs = this.getJobs()
    const updatedJobs = jobs.map(job => 
      job.id === jobId 
        ? { ...job, ...updates, updatedAt: Date.now() } as Job
        : job
    )
    this.saveJobs(updatedJobs)
    
    // Immediately sync to local state
    this.onJobUpdate?.(updatedJobs)
    
    Logger.log('JobCoordinator', 'Job updated', { jobId, updates })
    const updatedJob = updatedJobs.find(j => j.id === jobId)
    this.broadcast({ 
      type: 'job-updated', 
      jobId, 
      job: updatedJob 
    })
  }

  removeJob(jobId: string): void {
    const jobs = this.getJobs()
    const updatedJobs = jobs.filter(job => job.id !== jobId)
    this.saveJobs(updatedJobs)
    
    // Immediately sync to local state
    this.onJobUpdate?.(updatedJobs)
    
    Logger.log('JobCoordinator', 'Job removed', { jobId })
    this.broadcast({ type: 'job-updated', jobId })
  }

  getJobs(): Job[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  }

  private saveJobs(jobs: Job[]): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(jobs))
    } catch (error) {
      Logger.error('JobCoordinator', 'Failed to save jobs', error)
    }
  }

  clearCompletedJobs(): void {
    const jobs = this.getJobs()
    const activeJobs = jobs.filter(job => 
      job.status !== 'completed' && job.status !== 'failed'
    )
    this.saveJobs(activeJobs)
    
    // Immediately sync to local state
    this.onJobUpdate?.(activeJobs)
    
    Logger.log('JobCoordinator', 'Cleared completed jobs')
    this.broadcast({ type: 'queue-sync', jobs: activeJobs })
  }

  // Event handlers
  onJobsUpdate(callback: (jobs: Job[]) => void): void {
    this.onJobUpdate = callback
  }

  onLeadershipChange(callback: (isLeader: boolean) => void): void {
    this.onLeaderChange = callback
  }

  // Cleanup
  destroy(): void {
    this.channel.close()
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    
    if (this.leaderCheckInterval) {
      clearInterval(this.leaderCheckInterval)
    }
    
    Logger.log('JobCoordinator', 'Destroyed')
  }
}