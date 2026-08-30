import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadThemePreference, saveTheme, DEFAULT_THEME } from '../themePreference'

// The preference lives in localStorage, so these tests need a store to read
// and write. A map is enough: only getItem and setItem are ever reached.
const store = new Map<string, string>()

const fakeLocalStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) }
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', { localStorage: fakeLocalStorage })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('loadThemePreference', () => {
  it('reports a user who has never chosen as unset, on the default theme', () => {
    expect(loadThemePreference()).toEqual({ theme: DEFAULT_THEME, status: 'unset' })
  })

  it('reads back a theme that was saved', () => {
    saveTheme('dark')

    expect(loadThemePreference()).toEqual({ theme: 'dark', status: 'stored' })
  })

  it('round-trips every theme', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      saveTheme(theme)
      expect(loadThemePreference()).toEqual({ theme, status: 'stored' })
    }
  })

  it('distinguishes a stored value it cannot parse from one that was never set', () => {
    store.set('theme', 'dark')

    expect(loadThemePreference()).toEqual({ theme: DEFAULT_THEME, status: 'unreadable' })
  })

  it('treats a parseable value that is not a theme as unreadable too', () => {
    store.set('theme', JSON.stringify('midnight'))

    expect(loadThemePreference()).toEqual({ theme: DEFAULT_THEME, status: 'unreadable' })
  })

  it('reports storage the browser refuses as unreadable rather than unset', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('storage is disabled') },
        setItem: () => { throw new Error('storage is disabled') },
        removeItem: () => {}
      }
    })

    expect(loadThemePreference()).toEqual({ theme: DEFAULT_THEME, status: 'unreadable' })
  })

  it('leaves an unreadable preference on disk, so a later visit can still honour it', () => {
    store.set('theme', 'dark')

    loadThemePreference()

    expect(store.get('theme')).toBe('dark')
  })
})

describe('saveTheme', () => {
  it('reports success when the write lands', () => {
    expect(saveTheme('light')).toBe(true)
  })

  it('reports failure rather than throwing when storage refuses the write', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('quota exceeded') },
        removeItem: () => {}
      }
    })

    expect(saveTheme('light')).toBe(false)
  })
})
