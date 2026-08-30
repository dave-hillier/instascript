import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationProvider } from '../ConversationProvider'
import { ConversationContext } from '../ConversationContext'
import type { ConversationContextType } from '../ConversationContext'
import { AppContext } from '../AppContext'
import type { AppContextType } from '../AppContext'
import { ServiceContext } from '../ServiceContext'
import type { ServiceContextType } from '../ServiceContext'
import type { Script } from '../../types/script'
import type { RawGenerationCallbacks } from '../../services/rawScriptGenerationOrchestrator'
import { planGeneration } from '../../services/serviceFactory'

// The orchestrator is stood in for: the callbacks the provider hands it are
// the whole of the wiring under test, and getScript is the one that answers
// the run's model pin.
const orchestratorSpy = vi.hoisted(() => ({
  callbacks: undefined as RawGenerationCallbacks | undefined
}))

vi.mock('../../services/rawScriptGenerationOrchestrator', () => ({
  RawScriptGenerationOrchestrator: class {
    constructor(_services: unknown, callbacks: RawGenerationCallbacks) {
      orchestratorSpy.callbacks = callbacks
    }
    generateScript() {
      return Promise.resolve()
    }
  }
}))

const store = new Map<string, string>()

const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) }
}

beforeEach(() => {
  store.clear()
  orchestratorSpy.callbacks = undefined
  // sessionStorage as well as localStorage: the config read behind
  // planGeneration looks for the API key there
  vi.stubGlobal('window', { localStorage: fakeStorage, sessionStorage: fakeStorage })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const setModel = (model: string) => { store.set('model', JSON.stringify(model)) }

// Renders the provider over an app state and hands back its context, so a
// test can drive it the way a page does.
const mountProvider = (scripts: Script[]): ConversationContextType => {
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

  if (!contextValue) throw new Error('the provider published no context')
  return contextValue
}

// HomePage creates the script, creates its conversation, dispatches ADD_SCRIPT
// and awaits the run — all in one handler, so React never re-renders in
// between and the provider's view of the scripts is still the one from before
// the script existed. That is the path most runs start on, so it is the path
// the pin has to survive.
describe('the run model pin on a script created in the same event as its run', () => {
  it('plans from the model the new script was stamped with, not the setting at plan time', async () => {
    // The model in force when HomePage builds the script: it goes onto
    // Script.model and can be driven by tools
    setModel('gpt-5')

    // App state as the provider still sees it: ADD_SCRIPT has been dispatched
    // but no render has happened, so the new script is not here
    const context = mountProvider([])

    const scriptId = 'script_new'
    const conversation = context.createConversation(scriptId)

    // The setting changes while the run is getting under way — the switch the
    // pin exists to survive. planGeneration runs several awaits after the
    // handler that started this.
    setModel('gpt-3.5-turbo-instruct')

    await context.generateScript({ prompt: 'a script', conversationId: conversation.id })

    const callbacks = orchestratorSpy.callbacks
    if (!callbacks) throw new Error('no run was started')

    expect(callbacks.getScript?.(scriptId)?.model).toBe('gpt-5')

    const plan = planGeneration(callbacks.getScript?.(scriptId))
    expect(plan.model).toBe('gpt-5')
    expect(plan.mode).toBe('tools')
  })

  it('lets the stored script outrank a pin left over from an earlier creation', async () => {
    setModel('gpt-5')
    const stored: Script = {
      id: 'script_stored',
      title: 'Stored',
      content: '',
      createdAt: '2026-08-30',
      isArchived: false,
      model: 'gpt-3.5-turbo-instruct'
    }
    const context = mountProvider([stored])

    // A conversation created for some other script leaves a pin behind; it
    // must never answer for a script that has a record of its own
    context.createConversation('script_other')
    const conversation = context.createConversation(stored.id)

    await context.generateScript({ prompt: 'a script', conversationId: conversation.id })

    const callbacks = orchestratorSpy.callbacks
    if (!callbacks) throw new Error('no run was started')

    expect(callbacks.getScript?.(stored.id)?.model).toBe('gpt-3.5-turbo-instruct')
    expect(planGeneration(callbacks.getScript?.(stored.id)).mode).toBe('prose')
  })

  it('still falls back to the live setting for a script it has never heard of', async () => {
    setModel('gpt-5')
    const context = mountProvider([])
    const conversation = context.createConversation('script_new')

    await context.generateScript({ prompt: 'a script', conversationId: conversation.id })

    const callbacks = orchestratorSpy.callbacks
    if (!callbacks) throw new Error('no run was started')

    expect(callbacks.getScript?.('script_unknown')).toBeUndefined()
    expect(planGeneration(callbacks.getScript?.('script_unknown')).model).toBe('gpt-5')
  })
})
