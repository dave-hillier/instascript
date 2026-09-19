import { describe, it, expect, beforeEach } from 'vitest'
import {
  byPrice,
  findCatalogModel,
  getCachedCatalog,
  loadCatalog,
  parseCatalog,
  setCachedCatalog,
  type CatalogModel
} from '../openrouterCatalog'

const payload = {
  data: [
    {
      id: 'x-ai/grok-4.5',
      name: 'xAI: Grok 4.5',
      context_length: 256000,
      pricing: { prompt: '0.000002', completion: '0.000006' },
      supported_parameters: ['tools', 'reasoning'],
      architecture: { output_modalities: ['text'] }
    },
    {
      id: 'openai/gpt-5-nano',
      name: 'OpenAI: GPT-5 Nano',
      pricing: { prompt: '0.00000005', completion: '0.0000004' },
      supported_parameters: ['tools'],
      architecture: { output_modalities: ['text'] }
    },
    {
      id: 'some/image-model',
      name: 'An image model',
      pricing: { prompt: '0.00001', completion: '0' },
      supported_parameters: [],
      architecture: { output_modalities: ['image'] }
    }
  ]
}

const responseOf = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  }) as Response

beforeEach(() => {
  setCachedCatalog([], 0)
})

describe('parseCatalog', () => {
  it('reads ids, names, prices and tool support', () => {
    const [grok, nano] = parseCatalog(payload)

    expect(grok).toEqual({
      id: 'x-ai/grok-4.5',
      name: 'xAI: Grok 4.5',
      inputPerMillion: 2,
      outputPerMillion: 6,
      supportsTools: true,
      contextLength: 256000
    })
    expect(nano.outputPerMillion).toBeCloseTo(0.4)
    expect(nano.contextLength).toBeUndefined()
  })

  it('leaves out models that cannot answer in text', () => {
    expect(parseCatalog(payload).map(model => model.id)).not.toContain('some/image-model')
  })

  it('leaves a model unpriced rather than free when no price is published', () => {
    const [model] = parseCatalog({ data: [{ id: 'a/b', pricing: { prompt: '', completion: null } }] })

    expect(model.inputPerMillion).toBeUndefined()
    expect(model.outputPerMillion).toBeUndefined()
  })

  it('treats a routed model priced at -1 as unpriced rather than as cheapest', () => {
    const [router] = parseCatalog({
      data: [{ id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } }]
    })

    expect(router.inputPerMillion).toBeUndefined()
    expect(router.outputPerMillion).toBeUndefined()
  })

  it('falls back to the id when a model has no name, and drops entries with no id', () => {
    const models = parseCatalog({ data: [{ id: 'a/b' }, { name: 'nameless' }, 'nonsense'] })

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'a/b', name: 'a/b', supportsTools: false })
  })

  it('returns nothing for a payload of an unexpected shape', () => {
    expect(parseCatalog({})).toEqual([])
    expect(parseCatalog(null)).toEqual([])
  })
})

describe('loadCatalog', () => {
  it('fetches the catalogue and caches it for later synchronous reads', async () => {
    const result = await loadCatalog({ fetchFn: () => Promise.resolve(responseOf(payload)) })

    expect(result.error).toBeUndefined()
    expect(result.models).toHaveLength(2)
    expect(getCachedCatalog()).toHaveLength(2)
    expect(findCatalogModel('x-ai/grok-4.5')?.supportsTools).toBe(true)
  })

  it('serves the cached copy without fetching again while it is fresh', async () => {
    let calls = 0
    const fetchFn = (() => {
      calls += 1
      return Promise.resolve(responseOf(payload))
    }) as unknown as typeof fetch

    await loadCatalog({ fetchFn })
    await loadCatalog({ fetchFn })

    expect(calls).toBe(1)
  })

  it('refetches when forced', async () => {
    let calls = 0
    const fetchFn = (() => {
      calls += 1
      return Promise.resolve(responseOf(payload))
    }) as unknown as typeof fetch

    await loadCatalog({ fetchFn })
    await loadCatalog({ fetchFn, force: true })

    expect(calls).toBe(2)
  })

  it('reports an HTTP failure and keeps whatever was cached', async () => {
    await loadCatalog({ fetchFn: () => Promise.resolve(responseOf(payload)) })
    const result = await loadCatalog({
      fetchFn: () => Promise.resolve(responseOf({}, 502)),
      force: true
    })

    expect(result.error).toContain('502')
    expect(result.models).toHaveLength(2)
  })

  it('reports a network failure rather than throwing', async () => {
    const result = await loadCatalog({ fetchFn: () => Promise.reject(new Error('offline')) })

    expect(result.error).toBe('offline')
    expect(result.models).toEqual([])
  })
})

describe('byPrice', () => {
  const model = (id: string, outputPerMillion?: number): CatalogModel => ({
    id,
    name: id,
    outputPerMillion,
    inputPerMillion: outputPerMillion,
    supportsTools: true
  })

  it('orders cheapest first and sorts unpriced models last', () => {
    const sorted = [model('dear', 10), model('unpriced'), model('cheap', 0.4)].sort(byPrice)

    expect(sorted.map(entry => entry.id)).toEqual(['cheap', 'dear', 'unpriced'])
  })
})
