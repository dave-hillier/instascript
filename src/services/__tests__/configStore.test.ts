import { describe, it, expect, vi } from 'vitest'
import { subscribeToConfig, getConfigRevision, configChanged } from '../configStore'

describe('configStore', () => {
  it('notifies subscribers when a setting changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToConfig(listener)

    configChanged()

    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('stops notifying once unsubscribed', () => {
    const listener = vi.fn()
    subscribeToConfig(listener)()

    configChanged()

    expect(listener).not.toHaveBeenCalled()
  })

  it('reports a new revision after each change, so a snapshot comparison sees it', () => {
    const before = getConfigRevision()

    configChanged()

    expect(getConfigRevision()).not.toBe(before)
  })

  it('holds the revision steady between changes, so subscribers do not re-render in a loop', () => {
    configChanged()

    expect(getConfigRevision()).toBe(getConfigRevision())
  })
})
