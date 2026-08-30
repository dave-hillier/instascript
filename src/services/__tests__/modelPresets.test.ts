import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_MODELS, getModel, getUtilityModel } from '../config'
import { planGeneration } from '../serviceFactory'
import { ConversationProvider } from '../../contexts/ConversationProvider'
import { ConversationContext } from '../../contexts/ConversationContext'
import type { ConversationContextType } from '../../contexts/ConversationContext'
import { AppContext } from '../../contexts/AppContext'
import type { AppContextType } from '../../contexts/AppContext'
import { ServiceContext } from '../../contexts/ServiceContext'
import type { ServiceContextType } from '../../contexts/ServiceContext'
import type { Script } from '../../types/script'
import type { RawGenerationCallbacks } from '../rawScriptGenerationOrchestrator'

// The provider is what has to hand the run its script, so the run's model pin
// is exercised through the provider rather than by calling planGeneration with
// a script the test made up. Standing in for the orchestrator is enough: the
// callbacks it is constructed with are the whole of the wiring under test.
const orchestratorSpy = vi.hoisted(() => ({
  callbacks: undefined as RawGenerationCallbacks | undefined
}))

vi.mock('../rawScriptGenerationOrchestrator', () => ({
  RawScriptGenerationOrchestrator: class {
    constructor(_services: unknown, callbacks: RawGenerationCallbacks) {
      orchestratorSpy.callbacks = callbacks
    }
    generateScript() {
      return Promise.resolve()
    }
  }
}))
import { MODEL_PRICING } from '../generationCost'
import {
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  OPENAI_UTILITY_MODELS,
  OPENROUTER_UTILITY_MODELS,
  RETIRED_MODELS,
  TOOL_CALLING_SUPPORT,
  canAttemptToolCalling,
  resolveRetiredModel,
  supportsToolCalling
} from '../modelPresets'

// A model id saved by an older build lives in localStorage, so these tests
// need a store to write into. A map is enough: only getItem and setItem are
// ever reached.
const store = new Map<string, string>()

const fakeLocalStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) }
}

beforeEach(() => {
  store.clear()
  // sessionStorage as well as localStorage: the config read behind
  // planGeneration looks for the API key there, and a bare window makes it
  // log a failure that has nothing to do with what is being tested
  vi.stubGlobal('window', { localStorage: fakeLocalStorage, sessionStorage: fakeLocalStorage })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveRetiredModel', () => {
  it('maps a retired model to its successor', () => {
    expect(resolveRetiredModel('x-ai/grok-3-mini')).toBe('x-ai/grok-4.3')
    expect(resolveRetiredModel('x-ai/grok-3')).toBe('x-ai/grok-4.3')
  })

  it('leaves any other model alone, including custom ids', () => {
    expect(resolveRetiredModel('x-ai/grok-4.5')).toBe('x-ai/grok-4.5')
    expect(resolveRetiredModel('anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4')
  })

  it('names a successor that is itself still offered', () => {
    for (const successor of Object.values(RETIRED_MODELS)) {
      expect(RETIRED_MODELS[successor]).toBeUndefined()
    }
  })
})

describe('stored settings naming a retired model', () => {
  it('generates with the successor rather than the 404', () => {
    store.set('model', JSON.stringify('x-ai/grok-3'))

    expect(getModel()).toBe('x-ai/grok-4.3')
  })

  it('runs utility jobs on the successor rather than the 404', () => {
    store.set('apiProvider', JSON.stringify('openrouter'))
    store.set('utilityModel', JSON.stringify('x-ai/grok-3-mini'))

    expect(getUtilityModel()).toBe('x-ai/grok-4.3')
  })
})

describe('model presets', () => {
  it('offers no model the provider has retired', () => {
    const presets = [
      ...OPENAI_MODELS,
      ...OPENROUTER_MODELS,
      ...OPENAI_UTILITY_MODELS,
      ...OPENROUTER_UTILITY_MODELS
    ]
    for (const preset of presets) {
      expect(RETIRED_MODELS[preset.value], preset.value).toBeUndefined()
    }
  })

  it('defaults each role to a model that is still offered', () => {
    for (const role of ['generation', 'utility'] as const) {
      expect(RETIRED_MODELS[DEFAULT_MODELS.openai[role]]).toBeUndefined()
      expect(RETIRED_MODELS[DEFAULT_MODELS.openrouter[role]]).toBeUndefined()
    }
  })
})

// The utility role exists to keep the small jobs cheap, so the preference is
// expressed in the order of its lists: whichever model sits first is what the
// dropdown opens on and what the provider defaults to. These hold that order
// to the published prices, so a model added in the wrong place is caught here
// rather than by a bill.
describe('utility presets, cheapest first', () => {
  const utilityLists = {
    openai: OPENAI_UTILITY_MODELS,
    openrouter: OPENROUTER_UTILITY_MODELS
  }

  for (const [provider, models] of Object.entries(utilityLists)) {
    it(`orders the ${provider} list by ascending price`, () => {
      for (let i = 1; i < models.length; i++) {
        const previous = MODEL_PRICING[models[i - 1].value]
        const current = MODEL_PRICING[models[i].value]
        const label = `${models[i - 1].value} before ${models[i].value}`

        expect(previous.inputPerMillion, label).toBeLessThanOrEqual(current.inputPerMillion)
        if (previous.inputPerMillion === current.inputPerMillion) {
          expect(previous.outputPerMillion, label).toBeLessThanOrEqual(current.outputPerMillion)
        }
      }
    })

    it(`defaults ${provider} to the head of its utility list`, () => {
      expect(DEFAULT_MODELS[provider as 'openai' | 'openrouter'].utility).toBe(models[0].value)
    })
  }
})

// Generation drives the model with tool calls, so the capability table decides
// whether a configuration can write a script at all. These hold the two rules
// that make an incomplete table safe: every model we offer is capable, and a
// model we have never heard of is allowed to try rather than being quietly
// demoted.
describe('supportsToolCalling', () => {
  it('reports every generation preset as capable', () => {
    for (const preset of [...OPENAI_MODELS, ...OPENROUTER_MODELS]) {
      expect(supportsToolCalling(preset.value), preset.value).toBe(true)
    }
  })

  it('leaves a model it has never seen unknown', () => {
    expect(supportsToolCalling('anthropic/claude-sonnet-4')).toBe('unknown')
    expect(supportsToolCalling('some-vendor/model-not-released-yet')).toBe('unknown')
  })

  it('names the models it knows cannot be driven by tools', () => {
    expect(supportsToolCalling('gpt-3.5-turbo-instruct')).toBe(false)
    expect(supportsToolCalling('openai/gpt-3.5-turbo-instruct')).toBe(false)
  })

  it('judges a retired id on the successor that will serve the request', () => {
    for (const [retired, successor] of Object.entries(RETIRED_MODELS)) {
      expect(supportsToolCalling(retired), retired).toBe(supportsToolCalling(successor))
    }
  })

  it('ignores whitespace around a hand-typed model id', () => {
    expect(supportsToolCalling('  gpt-5  ')).toBe(true)
  })
})

describe('canAttemptToolCalling', () => {
  it('lets an unknown custom model try, so it is never silently stranded', () => {
    expect(canAttemptToolCalling('anthropic/claude-sonnet-4')).toBe(true)
  })

  it('holds back only the models known to have no tools parameter', () => {
    expect(canAttemptToolCalling('gpt-3.5-turbo-instruct')).toBe(false)
    expect(canAttemptToolCalling('gpt-5')).toBe(true)
  })

  it('agrees with the table for every id it lists', () => {
    for (const [model, capable] of Object.entries(TOOL_CALLING_SUPPORT)) {
      expect(canAttemptToolCalling(model), model).toBe(capable)
    }
  })
})


// The model a run is written by is pinned on the script (Script.model), and a
// run reads that pin through the getScript callback the provider supplies. A
// provider that supplies no getScript falls back to the live setting without
// saying so, which is how a script started on a tool-capable model would end up
// planned as prose after the setting was changed under it.
describe('the run model pin the ConversationProvider supplies', () => {
  const pinnedScript: Script = {
    id: 'script_pinned',
    title: 'Pinned',
    content: '',
    createdAt: '2026-08-30',
    isArchived: false,
    model: 'gpt-5'
  }

  const startRunAgainst = async (scripts: Script[]): Promise<RawGenerationCallbacks> => {
    orchestratorSpy.callbacks = undefined
    let contextValue: ConversationContextType | undefined

    const appContext: AppContextType = {
      state: { scripts, hoveredScript: null, interruptedScriptIds: [] },
      dispatch: () => {},
      activeScripts: scripts,
      archivedScripts: []
    }
    const serviceContext = {
      scriptService: {},
      exampleService: {}
    } as unknown as ServiceContextType

    const Capture = () => {
      contextValue = useContext(ConversationContext) ?? undefined
      return null
    }

    renderToStaticMarkup(
      createElement(
        AppContext.Provider,
        { value: appContext },
        createElement(
          ServiceContext.Provider,
          { value: serviceContext },
          createElement(ConversationProvider, null, createElement(Capture))
        )
      )
    )

    await contextValue!.generateScript({ prompt: 'a script', conversationId: 'conv_1' })

    if (!orchestratorSpy.callbacks) throw new Error('no run was started')
    return orchestratorSpy.callbacks
  }

  // Named for what it can see: the orchestrator is a stand-in here, so this
  // holds the provider's half of the wiring — the getScript it hands the run,
  // and the plan that callback makes possible. That the orchestrator actually
  // calls getScript is the orchestrator's own test to keep.
  it('answers getScript with the pinned script, so a plan made from it ignores the live setting', async () => {
    // The live setting names a model that cannot be driven by tools, so a plan
    // made from it differs from the pinned plan in mode as well as in model
    store.set('model', JSON.stringify('gpt-3.5-turbo-instruct'))
    expect(getModel()).toBe('gpt-3.5-turbo-instruct')

    const callbacks = await startRunAgainst([pinnedScript])

    expect(callbacks.getScript?.(pinnedScript.id)?.model).toBe('gpt-5')

    const plan = planGeneration(callbacks.getScript?.(pinnedScript.id))
    expect(plan.model).toBe('gpt-5')
    expect(plan.mode).toBe('tools')
  })

  it('falls back to the live setting for a script it does not hold', async () => {
    store.set('model', JSON.stringify('gpt-5'))

    const callbacks = await startRunAgainst([])

    expect(callbacks.getScript?.('script_pinned')).toBeUndefined()
    expect(planGeneration(callbacks.getScript?.('script_pinned')).model).toBe('gpt-5')
  })
})
