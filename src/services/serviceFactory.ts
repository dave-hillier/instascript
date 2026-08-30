import type { ScriptGenerationService } from './scriptGenerationService'
import type { ExampleSearchService } from './exampleSearchService'
import type { UtilityModelService } from './utilityModelService'
import { OpenAIService } from './openai'
import { OpenRouterService } from './openrouter'
import { MockAPIService } from './mockApi'
import { OpenAICompatibleUtilityService, MockUtilityService } from './utilityModel'
import { BundledExampleService } from './bundledExamples'
import { UnconfiguredScriptService, UnconfiguredUtilityService } from './unconfiguredProvider'
import { resolveProviderStatus } from './providerStatus'
import { createAppConfig, type AppConfig } from './config'
import { canAttemptToolCalling, resolveRetiredModel, supportsToolCalling } from './modelPresets'
import type { ToolCallingSupport } from './modelPresets'
import type { Script } from '../types/script'


// The mock is returned only when it is what the user picked. A real provider
// missing its key gets a service that fails with that reason, so a keyless
// session can no longer be mistaken for a bad generation.
export function createScriptService(config?: AppConfig): ScriptGenerationService {
  const appConfig = config || createAppConfig()
  const status = resolveProviderStatus(appConfig)

  switch (status.kind) {
    case 'live':
      return status.provider === 'openrouter'
        ? new OpenRouterService(appConfig.apiKey!)
        : new OpenAIService(appConfig.apiKey!)
    case 'mock':
      return new MockAPIService()
    case 'missing-key':
      return new UnconfiguredScriptService(status.provider)
  }
}

// The small-model service used by background jobs. Same provider and key as
// generation, different model: whatever the utility role is set to.
export function createUtilityService(config?: AppConfig): UtilityModelService {
  const appConfig = config || createAppConfig()
  const status = resolveProviderStatus(appConfig)

  switch (status.kind) {
    case 'live':
      return new OpenAICompatibleUtilityService(
        appConfig.apiKey!,
        status.provider,
        appConfig.utilityModel
      )
    case 'mock':
      return new MockUtilityService()
    case 'missing-key':
      return new UnconfiguredUtilityService(status.provider)
  }
}

export function createExampleService(): ExampleSearchService {
  return new BundledExampleService()
}


// How a run will be written, decided once when the run starts.
//
// The mode has to hold for the length of a run. A service is built from a
// config snapshot, but the provider classes re-read the model setting on every
// request, so a model changed halfway through a run applies from the next
// request onwards. In prose mode that only meant the second half of a script
// was written in a slightly different voice. With tool calling it decides
// whether the request can be served at all: switching from a capable model to
// one that ignores `tools` mid-run would mean the remaining sections cannot be
// written, and switching the other way would leave the run finishing in a mode
// it did not start in.
//
// `Script.model` is where the pin lives — it is written when the script is
// created and it persists. `planGeneration` resolves it once at run start, and
// the mode it returns is what the whole run is written in. It is only the mode
// that is pinned: nothing threads the resolved model through to the request, so
// each request is still sent to whatever `getModel()` says at the time. A model
// switched mid-run therefore changes the voice, but no longer the mode.
//
// A run started in the same event that created its script cannot read the pin
// off the stored record — no render has happened, so no store holds it yet.
// `findRunScript` is how that case still plans from the pin: the caller carries
// the model forward from the moment the script was stamped with it.
type GenerationMode = 'tools' | 'prose'

type GenerationPlan = {
  model: string
  toolCalling: ToolCallingSupport
  mode: GenerationMode
}

// The model a script was stamped with, carried by the caller that stamped it
// because the script record itself is not readable yet.
export type PendingRunPin = {
  scriptId: string
  model: string
}

// The script a run should plan from. The stored record wins whenever there is
// one: it holds the pin as saved, and a pending pin left over from an earlier
// creation must never override it. The pending pin answers only for the script
// it names, and only until the record exists.
export function findRunScript(
  scriptId: string,
  scripts: readonly Pick<Script, 'id' | 'model'>[],
  pending?: PendingRunPin | null
): Pick<Script, 'model'> | undefined {
  const stored = scripts.find(script => script.id === scriptId)
  if (stored) return stored
  return pending?.scriptId === scriptId ? { model: pending.model } : undefined
}

// The model a run should use: the one pinned on the script, falling back to
// the current setting for a run that has none (a script created by an older
// build, or one being started before its record exists). Retired ids resolve
// here as well, since a pin saved months ago can name a withdrawn model.
function resolveRunModel(script?: Pick<Script, 'model'>, config?: AppConfig): string {
  const pinned = script?.model?.trim()
  if (pinned) return resolveRetiredModel(pinned)
  return (config ?? createAppConfig()).model
}

// The export the orchestrator consults for the mode decision. An unknown model
// id plans for tools and finds out from the API, which is the deliberate
// choice: settings accept any model id, and refusing tools for everything we
// have not listed would strand custom models on the legacy path in silence.
export function planGeneration(script?: Pick<Script, 'model'>, config?: AppConfig): GenerationPlan {
  const model = resolveRunModel(script, config)
  return {
    model,
    toolCalling: supportsToolCalling(model),
    mode: canAttemptToolCalling(model) ? 'tools' : 'prose'
  }
}
