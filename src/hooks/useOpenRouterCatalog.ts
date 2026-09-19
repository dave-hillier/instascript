import { useEffect, useReducer } from 'react'
import {
  getCachedCatalog,
  loadCatalog,
  type CatalogModel
} from '../services/openrouterCatalog'

// The OpenRouter model list, as settings sees it. A cached copy is the
// starting state so the pickers are populated on the first paint; the fetch
// then refreshes it, and a failure leaves whatever was cached in place rather
// than emptying the lists.
export interface CatalogState {
  models: CatalogModel[]
  status: 'idle' | 'loading' | 'ready' | 'failed'
  error?: string
}

type CatalogEvent =
  | { type: 'LOAD_STARTED' }
  | { type: 'CATALOG_LOADED'; models: CatalogModel[] }
  | { type: 'CATALOG_LOAD_FAILED'; models: CatalogModel[]; error: string }

function catalogReducer(state: CatalogState, event: CatalogEvent): CatalogState {
  switch (event.type) {
    case 'LOAD_STARTED':
      return { ...state, status: 'loading', error: undefined }
    case 'CATALOG_LOADED':
      return { models: event.models, status: 'ready' }
    case 'CATALOG_LOAD_FAILED':
      return { models: event.models, status: 'failed', error: event.error }
  }
}

function initialState(): CatalogState {
  const cached = getCachedCatalog()
  return { models: cached, status: cached.length > 0 ? 'ready' : 'idle' }
}

// Loads the catalogue while `enabled` — settings only wants it while it is
// open on the OpenRouter provider, and nothing else in the app needs the list
export function useOpenRouterCatalog(enabled: boolean): CatalogState {
  const [state, dispatch] = useReducer(catalogReducer, undefined, initialState)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    dispatch({ type: 'LOAD_STARTED' })
    loadCatalog({ signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      if (result.error) {
        dispatch({ type: 'CATALOG_LOAD_FAILED', models: result.models, error: result.error })
      } else {
        dispatch({ type: 'CATALOG_LOADED', models: result.models })
      }
    })
    return () => controller.abort()
  }, [enabled])

  return state
}
