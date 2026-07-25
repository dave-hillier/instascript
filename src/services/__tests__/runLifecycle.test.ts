import { describe, it, expect } from 'vitest'
import { RunLifecycle, KeyedRunGuard } from '../runLifecycle'

// A manually-settled promise standing in for a generation run
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Lets queued microtask continuations run
async function settleMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('RunLifecycle', () => {
  it('admits a run and reports it as running', async () => {
    const lifecycle = new RunLifecycle()
    expect(lifecycle.isRunning).toBe(false)

    const controller = await lifecycle.admit()
    expect(controller.signal.aborted).toBe(false)
    expect(lifecycle.isRunning).toBe(true)
  })

  it('releases state when a tracked run completes normally', async () => {
    const lifecycle = new RunLifecycle()
    const controller = await lifecycle.admit()
    const run = deferred()

    const tracking = lifecycle.track(controller, run.promise)
    run.resolve()
    await tracking

    expect(lifecycle.isRunning).toBe(false)
  })

  it('rethrows a tracked run failure to the caller and still releases state', async () => {
    const lifecycle = new RunLifecycle()
    const controller = await lifecycle.admit()
    const run = deferred()

    const tracking = lifecycle.track(controller, run.promise)
    run.reject(new Error('generation failed'))

    await expect(tracking).rejects.toThrow('generation failed')
    expect(lifecycle.isRunning).toBe(false)
  })

  describe('stop-during-stream', () => {
    it('aborts the active controller and reports not running immediately, before the run settles', async () => {
      const lifecycle = new RunLifecycle()
      const controller = await lifecycle.admit()
      const run = deferred()
      const tracking = lifecycle.track(controller, run.promise)

      lifecycle.stop()

      // The abort reaches the stream and the caller can immediately observe
      // that no run is in progress, even though abort cleanup has not settled
      expect(controller.signal.aborted).toBe(true)
      expect(lifecycle.isRunning).toBe(false)

      // The run's abort path settles later without error
      run.resolve()
      await tracking
      expect(lifecycle.isRunning).toBe(false)
    })

    it('is a no-op when nothing is running', () => {
      const lifecycle = new RunLifecycle()
      expect(() => lifecycle.stop()).not.toThrow()
      expect(lifecycle.isRunning).toBe(false)
    })
  })

  describe('start-during-settlement', () => {
    it('admits a new run only after the previous run has fully settled', async () => {
      const lifecycle = new RunLifecycle()
      const events: string[] = []

      const controllerA = await lifecycle.admit()
      const runA = deferred()
      // Run A performs abort cleanup when its promise settles
      const trackingA = lifecycle.track(
        controllerA,
        runA.promise.then(() => {
          events.push('run A cleanup')
        })
      )

      // A successor asks for admission while A is still streaming
      const admission = lifecycle.admit().then(controller => {
        events.push('run B admitted')
        return controller
      })
      await settleMicrotasks()

      // Admission aborted A but must not complete until A settles
      expect(controllerA.signal.aborted).toBe(true)
      expect(events).toEqual([])

      runA.resolve()
      const controllerB = await admission
      await trackingA

      expect(events).toEqual(['run A cleanup', 'run B admitted'])
      expect(controllerB).not.toBe(controllerA)
      expect(controllerB.signal.aborted).toBe(false)
      expect(lifecycle.isRunning).toBe(true)
    })

    it('admits immediately when the previous run already settled', async () => {
      const lifecycle = new RunLifecycle()
      const controllerA = await lifecycle.admit()
      const runA = deferred()
      const trackingA = lifecycle.track(controllerA, runA.promise)
      runA.resolve()
      await trackingA

      const controllerB = await lifecycle.admit()
      expect(controllerB.signal.aborted).toBe(false)
      expect(lifecycle.isRunning).toBe(true)
    })
  })

  describe('abort-cleanup-after-replacement', () => {
    it('a predecessor settling late never clobbers the successor state', async () => {
      const lifecycle = new RunLifecycle()

      // Run A is admitted, then run B is admitted before A was ever tracked
      // (A's start was still in flight), which aborts A and installs B
      const controllerA = await lifecycle.admit()
      const controllerB = await lifecycle.admit()
      expect(controllerA.signal.aborted).toBe(true)

      // A's start finally gets around to tracking its (aborted, settling) run
      const runA = deferred()
      const trackingA = lifecycle.track(controllerA, runA.promise)
      runA.resolve()
      await trackingA

      // A's cleanup must not release B's controller
      expect(lifecycle.isRunning).toBe(true)

      // ...and B remains stoppable: stop aborts B, not a stale reference
      lifecycle.stop()
      expect(controllerB.signal.aborted).toBe(true)
      expect(lifecycle.isRunning).toBe(false)
    })

    it('a replaced run leaves the successor tracked run settlement intact', async () => {
      const lifecycle = new RunLifecycle()
      const events: string[] = []

      const controllerA = await lifecycle.admit()
      const controllerB = await lifecycle.admit()

      // B is tracked and streaming; A settles late afterwards
      const runB = deferred()
      const trackingB = lifecycle.track(controllerB, runB.promise)
      const runA = deferred()
      const trackingA = lifecycle.track(controllerA, runA.promise)
      runA.resolve()
      await trackingA

      // A third run's admission must still wait for B, proving A's late
      // cleanup did not clear the tracked settlement handle
      const admission = lifecycle.admit().then(() => {
        events.push('run C admitted')
      })
      await settleMicrotasks()
      expect(events).toEqual([])
      expect(controllerB.signal.aborted).toBe(true)

      runB.resolve()
      await trackingB
      await admission
      expect(events).toEqual(['run C admitted'])
    })
  })
})

describe('KeyedRunGuard', () => {
  it('admits the first run for a key and rejects a duplicate until finished', () => {
    const guard = new KeyedRunGuard()

    expect(guard.tryStart('conv-1-initial')).toBe(true)
    expect(guard.tryStart('conv-1-initial')).toBe(false)

    guard.finish('conv-1-initial')
    expect(guard.tryStart('conv-1-initial')).toBe(true)
  })

  it('tracks keys independently', () => {
    const guard = new KeyedRunGuard()

    expect(guard.tryStart('conv-1-initial')).toBe(true)
    expect(guard.tryStart('conv-1-Induction')).toBe(true)
    expect(guard.tryStart('conv-2-initial')).toBe(true)

    guard.finish('conv-1-Induction')
    expect(guard.tryStart('conv-1-initial')).toBe(false)
    expect(guard.tryStart('conv-1-Induction')).toBe(true)
  })
})
