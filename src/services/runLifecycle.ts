// The single-active-run invariant, extracted as a standalone unit (story 1.9):
// only one generation run may own the singleton generation state at a time.
// A new run is admitted only after the previous run has been aborted and its
// asynchronous abort-cleanup has fully settled, and a predecessor's late
// cleanup can never clobber the state a successor run has since claimed.
// This module has no UI dependencies.

export class RunLifecycle {
  private activeController: AbortController | null = null
  // The in-flight run, wrapped so awaiting it never rejects. Admission awaits
  // this so the previous run's abort-path cleanup settles before the new run
  // claims the singleton state.
  private activeRun: Promise<void> | null = null

  // True while a run holds an installed AbortController (i.e. a generation
  // is in progress and has not been stopped)
  get isRunning(): boolean {
    return this.activeController !== null
  }

  // Aborts the in-flight run, if any, without admitting a successor. The
  // controller is released synchronously so callers can immediately observe
  // that no run is in progress, even though the aborted run's cleanup may
  // still be settling.
  stop(): void {
    if (this.activeController) {
      this.activeController.abort()
      this.activeController = null
    }
  }

  // Run admission: aborts any existing run and waits until it has fully
  // settled (including its abort-path cleanup), then installs and returns a
  // fresh AbortController for the run about to start
  async admit(): Promise<AbortController> {
    this.stop()
    if (this.activeRun) {
      await this.activeRun
    }
    const controller = new AbortController()
    this.activeController = controller
    return controller
  }

  // Tracks an admitted run until it settles, then releases its controller and
  // settlement handle — but only if a successor run has not already replaced
  // them, so a predecessor's late cleanup can never clobber the successor's
  // state. Rethrows the run's failure to the caller.
  async track(controller: AbortController, run: Promise<void>): Promise<void> {
    const tracked = run.catch(() => {})
    // Only the run whose controller is currently installed may claim the
    // settlement handle; a stale predecessor tracked after replacement must
    // not overwrite a successor's handle
    if (this.activeController === controller) {
      this.activeRun = tracked
    }
    try {
      await run
    } finally {
      if (this.activeController === controller) {
        this.activeController = null
      }
      if (this.activeRun === tracked) {
        this.activeRun = null
      }
    }
  }
}

// Per-key re-entrancy guard: admits at most one run per key at a time. Used
// by the orchestrator so a duplicate request for the same generation (same
// conversation and section) is rejected while one is already in flight.
export class KeyedRunGuard {
  private active = new Set<string>()

  // Returns false when a run for this key is already in flight; otherwise
  // claims the key until finish() is called
  tryStart(key: string): boolean {
    if (this.active.has(key)) return false
    this.active.add(key)
    return true
  }

  finish(key: string): void {
    this.active.delete(key)
  }
}
