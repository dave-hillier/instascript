// Story 8.20: the devices a corpus writes with.
//
// A corpus is few-shot material: the exemplars are quoted in full and the
// model is left to work out for itself what they have in common. What it
// works out is never stated anywhere — whereas the app's own style rules,
// written before any of this material existed, are stated very plainly
// indeed. An instruction beats an inference, so a generation drifts towards
// the rules and away from the scripts it was supposed to be learning from.
//
// This module is the other half of the pair: what the corpus actually does,
// said as plainly as the rules are said. A device is a repeatable move — how
// a script opens, how it hands the listener from one state to the next, a
// phrase it returns to, the shape of its suggestions, how it marks breath or
// time, how it closes.
//
// Extraction is a map and a reduce (the running of it is in
// deviceExtraction.ts): one cheap request per example asking what devices
// that script uses, then one request over the pooled answers asking which of
// them recur. The ones that recur are the corpus's; the ones that appear once
// belong to a single script. Everything checkable is checked in code — the
// format, the lengths, the duplicates, and whether a quote offered as an
// illustration is really in the corpus at all.

import type { ExampleRecord } from '../types/example'
import { getActiveExampleFolder, normalizeFolderName, UNFILED_FOLDER } from './exampleCorpus'

export interface CorpusDevice {
  // A few words naming the move, e.g. "Breath counted down from ten"
  name: string
  // One sentence, imperative, telling a writer how to use it
  instruction: string
  // A phrase from the corpus that shows it. Optional: a device whose
  // illustration could not be found in the corpus keeps the device and loses
  // the quote rather than carrying an invented one.
  quote?: string
}

// One example's worth of observations, on the way to the consolidation
export interface DeviceObservation {
  title: string
  devices: CorpusDevice[]
}

// What was extracted for one folder, and what it was extracted from
export interface CorpusDeviceSet {
  folder: string
  devices: CorpusDevice[]
  // The utility model that read the corpus, so the panel can say who said this
  model: string
  generatedAt: number
  // How many examples were read
  sources: number
  // What the folder looked like when it was read, so a corpus that has moved
  // on since can say so
  signature: string
}

// How many devices a supplement may carry. Past about ten this stops being a
// description of a style and starts being a second rulebook — and a rulebook
// is the thing it exists to counterweight.
export const MAX_DEVICES = 10

// Per example: enough to characterise one script without inviting a list of
// everything it happens to do
export const MAX_DEVICES_PER_EXAMPLE = 8

// What makes a device the corpus's rather than one script's: that a second
// script does it too. A folder holding a single script is still a corpus and
// is still read, but there is nothing there for a device to recur across, so
// the consolidation is asked a different question.
export const MIN_SOURCES_FOR_RECURRENCE = 2

// A name is a label, an instruction is a sentence, a quote is an illustration.
// Anything longer is the model writing an essay in a field meant for a phrase.
const MAX_NAME_WORDS = 8
const MAX_NAME_LENGTH = 64
const MAX_INSTRUCTION_WORDS = 45
const MAX_INSTRUCTION_LENGTH = 320
const MAX_QUOTE_WORDS = 25
const MAX_QUOTE_LENGTH = 200

// Below this there is not enough script to find a device in, and the request
// would cost more than it returns
export const MIN_DEVICE_SOURCE_LENGTH = 400

// The one line format both requests answer in. A leading list marker or
// number is tolerated, since small models reach for them unprompted.
const DEVICE_LINE = /^\s*(?:[-*+]\s*)?(?:\d+[.)]\s*)?DEVICE\s*:\s*(.+)$/i

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

// Pure: a field with the decoration a small model wraps it in taken off
function cleanField(value: string): string {
  return value
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isUsableName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false
  if (wordCount(name) > MAX_NAME_WORDS) return false
  return /\p{L}/u.test(name)
}

function isUsableInstruction(instruction: string): boolean {
  if (!instruction || instruction.length > MAX_INSTRUCTION_LENGTH) return false
  if (wordCount(instruction) > MAX_INSTRUCTION_WORDS) return false
  return /\p{L}/u.test(instruction)
}

// Pure: the quote field, or '' where there is nothing usable in it. A quote
// is an illustration, so an over-long one is dropped rather than truncated —
// truncating would make a verbatim quote no longer verbatim.
function cleanQuote(value: string): string {
  const quote = cleanField(value)
  if (!quote || quote.length > MAX_QUOTE_LENGTH) return ''
  if (wordCount(quote) > MAX_QUOTE_WORDS) return ''
  if (!/\p{L}/u.test(quote)) return ''
  return quote
}

// Pure: the devices in a model reply. Lines that do not fit the format are
// skipped, so preamble, commentary and code fences from a less obedient model
// are tolerated; a device named twice is kept once, the first time.
export function parseDeviceLines(text: string, limit = MAX_DEVICES): CorpusDevice[] {
  const devices: CorpusDevice[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const match = line.match(DEVICE_LINE)
    if (!match) continue

    const parts = match[1].split('|').map(part => part.trim())
    const name = cleanField(parts[0] ?? '')
    const instruction = cleanField(parts[1] ?? '')
    if (!isUsableName(name) || !isUsableInstruction(instruction)) continue

    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    // Everything past the second separator is the quote: a quote may itself
    // contain a pipe, and losing the tail of one is worse than keeping it
    const quote = cleanQuote(parts.slice(2).join(' | '))
    devices.push(quote ? { name, instruction, quote } : { name, instruction })
    if (devices.length >= limit) break
  }

  return devices
}

// Pure: a device back in the line format, so the consolidation request reads
// the same shape it is asked to answer in
export function formatDeviceLine(device: CorpusDevice): string {
  const quote = device.quote ? ` | ${device.quote}` : ''
  return `DEVICE: ${device.name} | ${device.instruction}${quote}`
}

// Pure: text reduced to what a quote is compared on. Quotation marks vary
// with whoever typed them and whitespace varies with the markdown, but the
// words and the pause marks are the script's own and are kept.
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'“”‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Pure: the devices with any quote that is not actually in the corpus removed.
// The quote is the one field of a device that claims to be somebody else's
// words, so it is the one field that can be checked — and a supplement that
// illustrates the corpus with a line the corpus never contained is worse than
// one that does not illustrate itself at all.
export function verifyDeviceQuotes(
  devices: CorpusDevice[],
  corpus: string[]
): CorpusDevice[] {
  const haystack = corpus.map(normalizeForMatch).join('\n')
  return devices.map(device => {
    if (!device.quote) return device
    if (haystack.includes(normalizeForMatch(device.quote))) return device
    return { name: device.name, instruction: device.instruction }
  })
}

// Pure: what a folder's material looks like right now, as one short string.
// Ids and lengths rather than the text itself: the point is only to notice
// that the corpus has moved on since it was read, and reading every script to
// say so would cost more than the answer is worth.
export function corpusSignature(examples: ExampleRecord[]): string {
  const parts = examples
    .map(example => `${example.id}:${example.content.length}`)
    .sort()

  let hash = 5381
  const joined = parts.join('|')
  for (let index = 0; index < joined.length; index += 1) {
    hash = ((hash << 5) + hash + joined.charCodeAt(index)) | 0
  }
  return `${parts.length}:${(hash >>> 0).toString(36)}`
}

// Pure: whether these devices were read from a corpus that has since changed
export function areDevicesStale(
  set: CorpusDeviceSet | null,
  examples: ExampleRecord[]
): boolean {
  if (!set) return false
  return set.signature !== corpusSignature(examples)
}

// Pure: the examples worth reading for devices — the ones with enough script
// in them to hold one
export function deviceSourcesIn(examples: ExampleRecord[]): ExampleRecord[] {
  return examples.filter(
    example => example.content.trim().length >= MIN_DEVICE_SOURCE_LENGTH
  )
}

// --- Storage --------------------------------------------------------------
// One record per folder, in a single key, so switching the folder that
// grounds generation switches the supplement with it. Devices belong to the
// material they were read from: a supplement extracted from one folder would
// be a description of the wrong corpus applied to another.

export const CORPUS_DEVICES_KEY = 'corpusDevices'

function isDevice(value: unknown): value is CorpusDevice {
  if (typeof value !== 'object' || value === null) return false
  const { name, instruction, quote } = value as Record<string, unknown>
  if (typeof name !== 'string' || !isUsableName(name)) return false
  if (typeof instruction !== 'string' || !isUsableInstruction(instruction)) return false
  return quote === undefined || typeof quote === 'string'
}

// Pure: the stored sets, keeping only records that are still the right shape.
// Hand-edited or half-written storage leaves the folder without a supplement
// rather than putting a malformed one into a prompt.
export function parseDeviceSets(raw: string | null): Record<string, CorpusDeviceSet> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

    const sets: Record<string, CorpusDeviceSet> = {}
    for (const [folder, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      if (!Array.isArray(record.devices)) continue
      const devices = record.devices.filter(isDevice).slice(0, MAX_DEVICES)
      if (devices.length === 0) continue
      sets[folder] = {
        folder,
        devices,
        model: typeof record.model === 'string' ? record.model : '',
        generatedAt: typeof record.generatedAt === 'number' ? record.generatedAt : 0,
        sources: typeof record.sources === 'number' ? record.sources : devices.length,
        signature: typeof record.signature === 'string' ? record.signature : ''
      }
    }
    return sets
  } catch {
    return {}
  }
}

// Prompt assembly reads these, and prompts are also built outside a browser —
// in tests, and in any non-DOM context — where there is nothing to read
function readDeviceSets(): Record<string, CorpusDeviceSet> {
  if (typeof window === 'undefined') return {}
  try {
    return parseDeviceSets(window.localStorage.getItem(CORPUS_DEVICES_KEY))
  } catch (error) {
    console.warn('Error loading corpus devices from localStorage:', error)
    return {}
  }
}

function writeDeviceSets(sets: Record<string, CorpusDeviceSet>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CORPUS_DEVICES_KEY, JSON.stringify(sets))
  } catch (error) {
    console.warn('Error saving corpus devices to localStorage:', error)
  }
}

function folderKey(folder: string): string {
  return normalizeFolderName(folder) || UNFILED_FOLDER
}

export function getCorpusDevices(folder: string): CorpusDeviceSet | null {
  return readDeviceSets()[folderKey(folder)] ?? null
}

export function saveCorpusDevices(set: CorpusDeviceSet): CorpusDeviceSet {
  const key = folderKey(set.folder)
  const stored: CorpusDeviceSet = { ...set, folder: key }
  writeDeviceSets({ ...readDeviceSets(), [key]: stored })
  return stored
}

export function clearCorpusDevices(folder: string): void {
  const sets = readDeviceSets()
  const key = folderKey(folder)
  if (!(key in sets)) return
  delete sets[key]
  writeDeviceSets(sets)
}

// The supplement generation carries: the devices of the folder retrieval is
// drawing on, and nothing when that folder has never been read. Called as
// each prompt is built, the same way the standing instructions are, so every
// request in a run carries the identical string.
export function getActiveCorpusDevices(): CorpusDevice[] {
  if (typeof window === 'undefined') return []
  return getCorpusDevices(getActiveExampleFolder())?.devices ?? []
}
