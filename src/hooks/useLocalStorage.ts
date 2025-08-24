import { useReducer, useEffect } from 'react'

type LocalStorageAction<T> = 
  | { type: 'SET_VALUE'; value: T }
  | { type: 'LOAD_VALUE'; value: T | null }

type LocalStorageState<T> = {
  value: T | null
  isLoaded: boolean
}

const localStorageReducer = <T>(
  state: LocalStorageState<T>, 
  action: LocalStorageAction<T>
): LocalStorageState<T> => {
  switch (action.type) {
    case 'SET_VALUE':
      return { value: action.value, isLoaded: true }
    case 'LOAD_VALUE':
      return { value: action.value, isLoaded: true }
    default:
      return state
  }
}

export const useLocalStorage = <T>(key: string, defaultValue: T | null = null) => {
  const [state, dispatch] = useReducer(localStorageReducer<T>, {
    value: defaultValue,
    isLoaded: false
  })

  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key)
      const value = item ? JSON.parse(item) : null
      dispatch({ type: 'LOAD_VALUE', value })
    } catch (error) {
      console.warn(`Error loading localStorage key "${key}":`, error)
      dispatch({ type: 'LOAD_VALUE', value: null })
    }
  }, [key])

  const setValue = (value: T) => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
      dispatch({ type: 'SET_VALUE', value })
    } catch (error) {
      console.error(`Error saving to localStorage key "${key}":`, error)
    }
  }

  const removeValue = () => {
    try {
      window.localStorage.removeItem(key)
      dispatch({ type: 'SET_VALUE', value: null })
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error)
    }
  }

  return {
    value: state.value,
    isLoaded: state.isLoaded,
    setValue,
    removeValue
  }
}