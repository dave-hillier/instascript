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
  // Story 8.21: the words in this device that belong to this collection and
  // to nobody else — a hypnotist's or a character's name, a coined trigger
  // word, a phrase this writer minted. Absent where the device is built out
  // of the ordinary words of the craft. Every term listed here has been
  // found in the device's own text.
  bound?: string[]
  // The same move said without those words, for a script that is to sound
  // like this corpus without borrowing what is particular to it. Absent
  // where none could be had: the device is then simply left out of a generic
  // generation rather than sent with the words still in it.
  generic?: GenericForm
}

// A bound device restated: the same move, named and instructed without the
// collection's own words in it
export interface GenericForm {
  name: string
  instruction: string
}

// How closely a generation follows the corpus it is grounded in (story 8.21).
// "faithful" sends the devices as they were read, cue words and names and
// all — the corpus's voice reproduced. "generic" sends the moves and leaves
// the particulars behind: what the collection does, written with words this
// brief supports rather than with words that only mean something to somebody
// who already knows these scripts.
export type StyleFidelity = 'faithful' | 'generic'

export function parseStyleFidelity(value: unknown): StyleFidelity {
  return value === 'generic' ? 'generic' : 'faithful'
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
  // Whether the generalisation pass (story 8.21) ran over these devices. A
  // set read before that pass existed carries no bound terms, which is
  // indistinguishable from a corpus that has nothing particular in it — so
  // the run says which it was rather than leaving it to be guessed.
  generalised: boolean
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

// Story 8.21's line, answered by the generalisation request. Same tolerance
// for the decorations a small model adds unprompted.
const GENERIC_LINE = /^\s*(?:[-*+]\s*)?(?:\d+[.)]\s*)?GENERIC\s*:\s*(.+)$/i

// How many of the collection's own words one device may be bound to. Past a
// handful the model has stopped naming what is particular and started
// listing the device back to itself.
export const MAX_BOUND_TERMS = 6

// A term is a name or a coined word, occasionally two words. Shorter than
// this and it is a fragment that would match halfway through other words;
// longer and it is a sentence, not a word the corpus owns.
const MIN_TERM_LENGTH = 3
const MAX_TERM_LENGTH = 48

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

// --- What is particular to this corpus (story 8.21) ------------------------
// A device describes a move, and a move travels: any writer can open by
// handing the body's weight to the chair. What does not travel is the words a
// particular collection built its moves out of — the hypnotist's name, the
// cue word this writer coined, the phrase that only lands for somebody who
// already knows these scripts. "Drop" belongs to the craft; "abattoir"
// belongs to whoever wrote it.
//
// The generalisation request names those words and says the device again
// without them. Both halves are checkable and both are checked: a word
// claimed to be in a device must actually be in it, and a restatement that
// still contains one is not a restatement.

// Pure: a term escaped for use in a match
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Pure: whether a term appears in text as a word rather than as a fragment of
// one. "Ash" is not in "ashes"; "Miss Vera" is in "you drop for Miss Vera".
export function containsTerm(text: string, term: string): boolean {
  const haystack = normalizeForMatch(text)
  const needle = normalizeForMatch(term)
  if (!needle) return false
  // Written with edge alternatives rather than a lookbehind: the same test,
  // and no Safari version to check
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeForRegExp(needle)}($|[^\\p{L}\\p{N}])`,
    'u'
  ).test(haystack)
}

// Pure: everything of a device that goes into a prompt, as one string to
// search. The quote is part of it: a quote is where a cue word most often
// hides.
function deviceText(device: CorpusDevice): string {
  return [device.name, device.instruction, device.quote ?? ''].join(' ')
}

// Pure: the terms of one generic line that survive checking — the ones
// really in the device they were claimed of. A term the device does not
// contain is the model describing the corpus from memory rather than reading
// the line in front of it, and is dropped.
function verifyTerms(raw: string, device: CorpusDevice): string[] {
  const text = deviceText(device)
  const terms: string[] = []
  const seen = new Set<string>()

  for (const part of raw.split(/[,;]/)) {
    const term = cleanField(part)
    if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) continue
    if (!/\p{L}/u.test(term)) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    if (!containsTerm(text, term)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= MAX_BOUND_TERMS) break
  }

  return terms
}

// Pure: the devices with story 8.21's marks on them. Each line names a device
// already in the list, the words in it that belong to this collection, and
// the same move said without them.
//
// A line whose terms cannot be found in the device it names is dropped
// whole — nothing about it can be trusted. A line whose terms check out but
// whose restatement still contains one of them keeps the marking and loses
// the restatement: knowing a device is particular is worth having on its own,
// since it is what keeps the device out of a generic generation.
export function parseGenericLines(text: string, devices: CorpusDevice[]): CorpusDevice[] {
  const byName = new Map(devices.map(device => [device.name.toLowerCase(), device]))
  const marks = new Map<string, { bound: string[]; generic?: GenericForm }>()

  for (const line of text.split('\n')) {
    const match = line.match(GENERIC_LINE)
    if (!match) continue

    const parts = match[1].split('|').map(part => part.trim())
    if (parts.length < 4) continue

    const key = cleanField(parts[0]).toLowerCase()
    const device = byName.get(key)
    if (!device || marks.has(key)) continue

    const bound = verifyTerms(parts.slice(3).join(', '), device)
    if (bound.length === 0) continue

    const name = cleanField(parts[1])
    const instruction = cleanField(parts[2])
    const clean =
      isUsableName(name) &&
      isUsableInstruction(instruction) &&
      !bound.some(term => containsTerm(`${name} ${instruction}`, term))

    marks.set(key, clean ? { bound, generic: { name, instruction } } : { bound })
  }

  return devices.map(device => {
    const mark = marks.get(device.name.toLowerCase())
    if (!mark) return device
    return mark.generic
      ? { ...device, bound: mark.bound, generic: mark.generic }
      : { ...device, bound: mark.bound }
  })
}

// Pure: every term any device in the set is bound to. A cue word marked on
// one device is still that collection's word wherever else it turns up.
export function boundTerms(devices: CorpusDevice[]): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const device of devices) {
    for (const term of device.bound ?? []) {
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      terms.push(term)
    }
  }
  return terms
}

// Pure: the devices as the chosen fidelity sends them.
//
// Faithful sends them as they were read. Generic sends the moves without the
// collection's own words: a device that has a restatement is sent in it, a
// device that carries one of those words and has no restatement is left out
// rather than smuggling the word through, and a quote is kept only where it
// illustrates the move without naming anything particular.
export function devicesForFidelity(
  devices: CorpusDevice[],
  fidelity: StyleFidelity
): CorpusDevice[] {
  if (fidelity === 'faithful') return devices

  const terms = boundTerms(devices)
  const generic: CorpusDevice[] = []

  for (const device of devices) {
    // The restatement where there is one, the device itself where there is
    // none, and neither where what comes out still names something of the
    // collection's own — a device can carry a word marked on another one
    const { name, instruction } = device.generic ?? device
    if (terms.some(term => containsTerm(`${name} ${instruction}`, term))) continue

    const quote =
      device.quote && !terms.some(term => containsTerm(device.quote as string, term))
        ? device.quote
        : undefined
    generic.push(quote ? { name, instruction, quote } : { name, instruction })
  }

  return generic
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

// Pure: a stored device's marks, kept only where they are still the shape
// the generalisation pass produced. Storage is hand-editable, so a malformed
// restatement costs the device its marks rather than putting a half-written
// one into a prompt.
function readDeviceMarks(record: Record<string, unknown>): Partial<CorpusDevice> {
  const bound = Array.isArray(record.bound)
    ? record.bound
        .filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
        .map(term => term.trim())
        .slice(0, MAX_BOUND_TERMS)
    : []
  if (bound.length === 0) return {}

  const generic = record.generic
  if (typeof generic !== 'object' || generic === null) return { bound }
  const { name, instruction } = generic as Record<string, unknown>
  if (typeof name !== 'string' || !isUsableName(name)) return { bound }
  if (typeof instruction !== 'string' || !isUsableInstruction(instruction)) return { bound }
  return { bound, generic: { name, instruction } }
}

function isDevice(value: unknown): value is CorpusDevice {
  if (typeof value !== 'object' || value === null) return false
  const { name, instruction, quote } = value as Record<string, unknown>
  if (typeof name !== 'string' || !isUsableName(name)) return false
  if (typeof instruction !== 'string' || !isUsableInstruction(instruction)) return false
  return quote === undefined || typeof quote === 'string'
}

// Pure: a stored device reduced to the fields this build understands
function readDevice(value: CorpusDevice): CorpusDevice {
  const marks = readDeviceMarks(value as unknown as Record<string, unknown>)
  const quote = typeof value.quote === 'string' && value.quote ? { quote: value.quote } : {}
  return { name: value.name, instruction: value.instruction, ...quote, ...marks }
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
      const devices = record.devices.filter(isDevice).slice(0, MAX_DEVICES).map(readDevice)
      if (devices.length === 0) continue
      sets[folder] = {
        folder,
        devices,
        model: typeof record.model === 'string' ? record.model : '',
        generatedAt: typeof record.generatedAt === 'number' ? record.generatedAt : 0,
        sources: typeof record.sources === 'number' ? record.sources : devices.length,
        signature: typeof record.signature === 'string' ? record.signature : '',
        // A set stored before story 8.21 has no flag and no marks, and says
        // so: it was never asked what in it is particular to the collection
        generalised: record.generalised === true
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

// Whether the folder grounding generation has been read for what is
// particular to it (story 8.21). A generic generation from a corpus that has
// not can only fall back to the standing instruction not to borrow the
// exemplars' own words, so the panel offers to read it again.
export function areActiveDevicesGeneralised(): boolean {
  if (typeof window === 'undefined') return false
  return getCorpusDevices(getActiveExampleFolder())?.generalised === true
}
