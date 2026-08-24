export type Theme = 'light' | 'dark' | 'system'

export const DEFAULT_THEME: Theme = 'system'

const THEME_KEY = 'theme'

// How the stored preference came back. The distinction matters because a
// failed read and an absent one are not the same thing: 'unset' is a user who
// has never chosen a theme, while 'unreadable' means a choice is stored that
// we could not get at — corrupt JSON, a value written by a release that named
// its themes differently, or storage the browser refused us. Treating the
// second as the first is what loses the preference: the default gets shown as
// though it were the saved choice, and then written back over the real one.
export type ThemeReadStatus = 'stored' | 'unset' | 'unreadable'

export type ThemePreference = {
  theme: Theme
  status: ThemeReadStatus
}

const isTheme = (value: unknown): value is Theme =>
  value === 'light' || value === 'dark' || value === 'system'

export function loadThemePreference(): ThemePreference {
  let item: string | null
  try {
    item = window.localStorage.getItem(THEME_KEY)
  } catch (error) {
    console.warn('Error loading theme from localStorage:', error)
    return { theme: DEFAULT_THEME, status: 'unreadable' }
  }

  if (item === null) {
    return { theme: DEFAULT_THEME, status: 'unset' }
  }

  try {
    const parsed: unknown = JSON.parse(item)
    if (isTheme(parsed)) {
      return { theme: parsed, status: 'stored' }
    }
  } catch {
    // A value is there but it is not JSON we can read; reported below with
    // the same outcome as a value that parses to something we don't know
  }

  console.warn(`Theme preference in localStorage is not a theme this release understands: ${item}`)
  return { theme: DEFAULT_THEME, status: 'unreadable' }
}

// Called only when the user picks a theme, never on load. A preference we
// failed to read stays on disk untouched, so the next release — or the next
// visit, if storage was momentarily unavailable — can still honour it.
export function saveTheme(theme: Theme): boolean {
  try {
    window.localStorage.setItem(THEME_KEY, JSON.stringify(theme))
    return true
  } catch (error) {
    console.error('Error saving theme to localStorage:', error)
    return false
  }
}
