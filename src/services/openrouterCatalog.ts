// OpenRouter's model catalogue (GET /api/v1/models), which is what settings
// offers instead of a hand-written short list. The endpoint is public — it
// ignores the Authorization header — so the list can be loaded before a key
// has been entered.
//
// Everything the app wants to know about a model is in the response: its
// display name, its published price, and whether it accepts a `tools`
// parameter. The static tables in modelPresets and generationCost stay as the
// offline fallback — a catalogue that cannot be fetched must not take the cost
// line and the tool-calling warning down with it.

const CATALOG_ENDPOINT = 'https://openrouter.ai/api/v1/models'

// The catalogue changes slowly — new models appear, prices move occasionally —
// and settings is opened often, so a cached copy is served immediately and
// refreshed in the background once a day.
const CACHE_KEY = 'openrouterCatalog'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface CatalogModel {
  id: string
  name: string
  // USD per million tokens. Absent where OpenRouter publishes no price, which
  // it does for a few routed and free endpoints.
  inputPerMillion?: number
  outputPerMillion?: number
  // Whether the model's API takes a `tools` parameter. Generation drives the
  // model by tool calls, so this is what decides whether a model can write a
  // script at all.
  supportsTools: boolean
  contextLength?: number
}

interface CachedCatalog {
  fetchedAt: number
  models: CatalogModel[]
}

// OpenRouter prices in USD per token, as decimal strings. A missing, empty or
// unparseable price means "not published" rather than "free": a zero would
// quietly report every generation as costing nothing. So does a negative one —
// the routers (openrouter/auto and friends) price at "-1", meaning the cost
// depends on whichever model the router picks, and a literal reading would put
// them at the head of a cheapest-first list at minus a million dollars.
function perMillion(price: unknown): number | undefined {
  if (typeof price !== 'string' || price.trim() === '') return undefined
  const value = Number(price)
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

// Reads the endpoint's payload into the fields the app uses, dropping any
// entry without an id. The parse is deliberately forgiving: a field the
// catalogue adds, renames or omits should cost that one model its price or its
// name, never the whole list.
export function parseCatalog(payload: unknown): CatalogModel[] {
  const data = asRecord(payload)?.data
  if (!Array.isArray(data)) return []

  const models: CatalogModel[] = []
  for (const entry of data) {
    const model = asRecord(entry)
    const id = model?.id
    if (typeof id !== 'string' || id.trim() === '') continue

    const pricing = asRecord(model?.pricing)
    const parameters = model?.supported_parameters
    const outputModalities = asRecord(model?.architecture)?.output_modalities

    // Only models that answer in text can write a script or run a utility
    // job. Image and audio outputs are in the same catalogue.
    if (Array.isArray(outputModalities) && !outputModalities.includes('text')) continue

    models.push({
      id,
      name: typeof model?.name === 'string' && model.name.trim() !== '' ? model.name : id,
      inputPerMillion: perMillion(pricing?.prompt),
      outputPerMillion: perMillion(pricing?.completion),
      supportsTools: Array.isArray(parameters) && parameters.includes('tools'),
      contextLength: typeof model?.context_length === 'number' ? model.context_length : undefined
    })
  }
  return models
}

// The catalogue is consulted synchronously — by the cost line and by the
// tool-calling check — so it is held in module state, hydrated from storage on
// first read rather than on import.
let cache: CachedCatalog | null | undefined

function readCache(): CachedCatalog | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(CACHE_KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored) as CachedCatalog
    if (!Array.isArray(parsed?.models) || typeof parsed?.fetchedAt !== 'number') return null
    return parsed
  } catch (error) {
    console.warn('Error loading the OpenRouter catalogue from localStorage:', error)
    return null
  }
}

function writeCache(entry: CachedCatalog): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch (error) {
    console.warn('Error saving the OpenRouter catalogue to localStorage:', error)
  }
}

// Whatever the last successful fetch returned, or an empty list before the
// first one. Never fetches: callers that can wait use loadCatalog.
export function getCachedCatalog(): CatalogModel[] {
  if (cache === undefined) cache = readCache()
  return cache?.models ?? []
}

export function findCatalogModel(id: string): CatalogModel | undefined {
  const wanted = id.trim()
  return getCachedCatalog().find(model => model.id === wanted)
}

// Test seam and a way to drop a corrupt cache
export function setCachedCatalog(models: CatalogModel[], fetchedAt = Date.now()): void {
  cache = { fetchedAt, models }
  writeCache(cache)
}

export interface LoadCatalogOptions {
  fetchFn?: typeof fetch
  // Refetch even when the cached copy is still fresh
  force?: boolean
  signal?: AbortSignal
}

export interface CatalogLoad {
  models: CatalogModel[]
  // Set when the list on hand is the cached or empty one because the fetch
  // failed, so settings can say why it is offering the short fallback list
  error?: string
}

// Returns the catalogue, fetching when the cached copy is missing or stale.
// A failed fetch is reported, not thrown: settings falls back to the presets
// and stays usable offline.
export async function loadCatalog(options: LoadCatalogOptions = {}): Promise<CatalogLoad> {
  if (cache === undefined) cache = readCache()

  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.models.length > 0
  if (fresh && !options.force) return { models: cache!.models }

  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
  try {
    const response = await fetchFn(CATALOG_ENDPOINT, { signal: options.signal })
    if (!response.ok) {
      return { models: getCachedCatalog(), error: `OpenRouter responded with HTTP ${response.status}.` }
    }
    const models = parseCatalog(await response.json())
    if (models.length === 0) {
      return { models: getCachedCatalog(), error: 'OpenRouter returned no models.' }
    }
    setCachedCatalog(models)
    return { models }
  } catch (error) {
    if (options.signal?.aborted) return { models: getCachedCatalog() }
    return {
      models: getCachedCatalog(),
      error: error instanceof Error ? error.message : 'The model list could not be loaded.'
    }
  }
}

// Cheapest first, by what a request actually costs: output tokens dominate a
// script, so they carry the ordering, with input as the tie-break. A model
// with no published price sorts last — it cannot be compared, and it would
// otherwise lead the list as if it were free.
export function byPrice(a: CatalogModel, b: CatalogModel): number {
  const aOut = a.outputPerMillion
  const bOut = b.outputPerMillion
  if (aOut === undefined && bOut === undefined) return a.id.localeCompare(b.id)
  if (aOut === undefined) return 1
  if (bOut === undefined) return -1
  if (aOut !== bOut) return aOut - bOut
  return (a.inputPerMillion ?? 0) - (b.inputPerMillion ?? 0)
}

export function byName(a: CatalogModel, b: CatalogModel): number {
  return a.name.localeCompare(b.name)
}
