import { describe, it, expect, vi, afterEach } from 'vitest'
import { subscribeToConfig, getConfigRevision, configChanged } from '../configStore'
import { isReviewPassEnabled } from '../config'

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

// The setting the round planner resolves its pipeline from: it decides whether
// a run performs the two critiques at all. It is read on the way into a
// generation run, and a run is exercised in a node process with no window, so
// both the stored answers and the no-window answer are worth holding.
describe('isReviewPassEnabled', () => {
  const withStoredSetting = (stored: string | null) => {
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => (key === 'reviewPass' ? stored : null) }
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is on when the setting has been switched on', () => {
    withStoredSetting('true')

    expect(isReviewPassEnabled()).toBe(true)
  })

  it('is off when the setting has been switched off', () => {
    withStoredSetting('false')

    expect(isReviewPassEnabled()).toBe(false)
  })

  it('is off when nothing has been stored, so pressing generate just generates', () => {
    withStoredSetting(null)

    expect(isReviewPassEnabled()).toBe(false)
  })

  // Read through readSetting rather than reaching for window.localStorage: the
  // bare read threw in a node process, where every other setting simply
  // returned its default.
  it('is off, rather than throwing, where there is no window at all', () => {
    expect(isReviewPassEnabled()).toBe(false)
  })
})
