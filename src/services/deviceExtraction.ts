// Story 8.20: running the device extraction over a folder.
//
// The map and the reduce. One request per example asks what devices that
// script uses; one request over the pooled answers asks which of them the
// collection has in common. The map is where the cost is — a folder of thirty
// scripts is thirty requests — so it is the utility model that reads them,
// the same small model that tags and sections an import.
//
// Everything the reply claims is checked here or in corpusDevices before it
// is stored: the line format, the field lengths, duplicate names, and whether
// a quote offered as an illustration appears in the corpus at all. A run that
// comes back with nothing usable stores nothing and says so, leaving whatever
// supplement the folder already had exactly as it was.

import type { ExampleRecord } from '../types/example'
import type { UtilityModelService } from './utilityModelService'
import type { ImportFileProgress } from './importProgress'
import {
  buildDeviceConsolidationPrompt,
  buildDeviceExtractionInput,
  buildDeviceExtractionPrompt,
  formatDeviceObservations
} from './prompts'
import {
  corpusSignature,
  deviceSourcesIn,
  MAX_DEVICES,
  MAX_DEVICES_PER_EXAMPLE,
  parseDeviceLines,
  verifyDeviceQuotes,
  type CorpusDevice,
  type CorpusDeviceSet,
  type DeviceObservation
} from './corpusDevices'

// A device line is a name, a sentence and a short quote. Ten of them is a
// small reply however long the script that produced them was.
const EXTRACTION_TOKEN_BUDGET = 1200

export interface DeviceExtractionOptions {
  signal?: AbortSignal
  // Called as each example's request goes out, so the meter can name the
  // script being read rather than showing an unexplained pause
  onExampleStarted?: (id: string) => void
  onExampleFinished?: (id: string, found: number) => void
  // Called once the reading is done and the consolidation request goes out
  onConsolidating?: () => void
}

// What one run came to. The set is null when nothing usable came back, which
// is an ordinary outcome — a corpus of three-line snippets has no devices to
// find — and is reported rather than stored.
export interface DeviceExtractionOutcome {
  set: CorpusDeviceSet | null
  // How many examples were read, and how many device observations they gave
  sources: number
  observations: number
}

// Reads one example for the devices it uses. A failed or unusable reply
// contributes nothing rather than failing the run.
async function readExample(
  example: ExampleRecord,
  service: UtilityModelService,
  signal?: AbortSignal
): Promise<CorpusDevice[]> {
  try {
    const reply = await service.complete({
      job: 'devices',
      system: buildDeviceExtractionPrompt(),
      user: buildDeviceExtractionInput(example.title, example.content),
      maxOutputTokens: EXTRACTION_TOKEN_BUDGET,
      signal
    })
    return parseDeviceLines(reply, MAX_DEVICES_PER_EXAMPLE)
  } catch (error) {
    console.warn(`Could not read devices from the example "${example.title}":`, error)
    return []
  }
}

// Reads a folder for the devices its scripts have in common. The folder's own
// examples are the only material: a supplement describes the corpus it was
// read from, and is stored against that folder alone.
export async function extractCorpusDevices(
  folder: string,
  examples: ExampleRecord[],
  service: UtilityModelService,
  { signal, onExampleStarted, onExampleFinished, onConsolidating }: DeviceExtractionOptions = {}
): Promise<DeviceExtractionOutcome> {
  const sources = deviceSourcesIn(examples)
  const observations: DeviceObservation[] = []

  // Sequential for the same reason the import and clean-up passes are: a
  // folder can be dozens of examples, and a queue of parallel requests to a
  // rate-limited key fails more of them than it finishes sooner
  for (const example of sources) {
    onExampleStarted?.(example.id)
    const devices = await readExample(example, service, signal)
    if (devices.length > 0) observations.push({ title: example.title, devices })
    onExampleFinished?.(example.id, devices.length)
  }

  const outcome: DeviceExtractionOutcome = {
    set: null,
    sources: sources.length,
    observations: observations.reduce((total, entry) => total + entry.devices.length, 0)
  }
  if (observations.length === 0) return outcome

  onConsolidating?.()
  let devices: CorpusDevice[] = []
  try {
    const reply = await service.complete({
      job: 'deviceDigest',
      system: buildDeviceConsolidationPrompt(observations.length),
      user: formatDeviceObservations(observations),
      maxOutputTokens: EXTRACTION_TOKEN_BUDGET,
      signal
    })
    devices = parseDeviceLines(reply, MAX_DEVICES)
  } catch (error) {
    console.warn(`Could not consolidate the devices of "${folder}":`, error)
    return outcome
  }

  // The quotes are checked against the corpus itself rather than against the
  // observations they were supposed to be copied from: what matters is that
  // the supplement illustrates itself with the corpus's own words, whichever
  // script they came from
  const verified = verifyDeviceQuotes(devices, examples.map(example => example.content))
  if (verified.length === 0) return outcome

  return {
    ...outcome,
    set: {
      folder,
      devices: verified,
      model: service.model,
      generatedAt: Date.now(),
      sources: sources.length,
      // The signature covers the whole folder, not only the examples that
      // were long enough to read: adding a short script to the folder still
      // changes the corpus the supplement claims to describe
      signature: corpusSignature(examples)
    }
  }
}

// The rows the meter is drawn from — one per example that will be read, so a
// folder holding scripts too short to read for devices does not show rows
// that never move
export function createDeviceProgress(examples: ExampleRecord[]): ImportFileProgress[] {
  return deviceSourcesIn(examples).map(example => ({
    id: example.id,
    path: example.title,
    name: example.title,
    stage: 'queued',
    exampleId: example.id
  }))
}

// Pure: what a finished run reads back as
export function describeDeviceOutcome(
  { set, sources, observations }: DeviceExtractionOutcome,
  model: string
): string {
  if (sources === 0) {
    return 'These scripts are too short to read for devices.'
  }
  const read = `${model} read ${sources} ${sources === 1 ? 'script' : 'scripts'}`
  if (!set) {
    return observations === 0
      ? `${read} and found no devices to describe them by.`
      : `${read} but found nothing the collection has in common.`
  }
  const found = set.devices.length
  return `${read} and found ${found} ${found === 1 ? 'device' : 'devices'} they share.`
}

// Pure: how the panel says a supplement is out of date. Null when the devices
// still describe the folder as it stands.
export function describeDeviceStaleness(stale: boolean, sources: number): string | null {
  if (!stale) return null
  return `The folder has changed since these were read from ${sources} ` +
    `${sources === 1 ? 'script' : 'scripts'}. Read it again to bring them up to date.`
}
