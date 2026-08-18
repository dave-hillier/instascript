import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  areActiveDevicesGeneralised,
  areDevicesStale,
  boundTerms,
  clearCorpusDevices,
  containsTerm,
  corpusSignature,
  CORPUS_DEVICES_KEY,
  devicesForFidelity,
  deviceSourcesIn,
  formatDeviceLine,
  getCorpusDevices,
  MAX_DEVICES,
  parseDeviceLines,
  parseDeviceSets,
  parseGenericLines,
  parseStyleFidelity,
  saveCorpusDevices,
  verifyDeviceQuotes,
  type CorpusDevice,
  type CorpusDeviceSet
} from '../corpusDevices'
import type { ExampleRecord } from '../../types/example'

const device = (overrides: Partial<CorpusDevice> = {}): CorpusDevice => ({
  name: 'Breath counted down',
  instruction: 'Tie each count to an out-breath so the descent is measured by breathing rather than by numbers.',
  quote: 'ten … and down … nine … and further down',
  ...overrides
})

const example = (overrides: Partial<ExampleRecord> = {}): ExampleRecord => ({
  id: 'example_1',
  title: 'Deep Rest',
  tags: [],
  content: 'a'.repeat(500),
  source: 'user',
  ...overrides
})

describe('parseDeviceLines', () => {
  it('reads the three fields of a device line', () => {
    const devices = parseDeviceLines(
      'DEVICE: Counted descent | Count the listener down on the out-breath. | ten … and down'
    )

    expect(devices).toEqual([
      {
        name: 'Counted descent',
        instruction: 'Count the listener down on the out-breath.',
        quote: 'ten … and down'
      }
    ])
  })

  it('tolerates preamble, list markers, numbering and code fences', () => {
    const devices = parseDeviceLines(
      [
        'Here are the devices I found:',
        '```',
        '- DEVICE: Counted descent | Count the listener down. | ten … and down',
        '2. DEVICE: Named return | Close by naming the room. | back in the room',
        '```'
      ].join('\n')
    )

    expect(devices.map(entry => entry.name)).toEqual(['Counted descent', 'Named return'])
  })

  it('keeps a device whose instruction contains no quote', () => {
    const devices = parseDeviceLines('DEVICE: Counted descent | Count the listener down.')

    expect(devices).toEqual([
      { name: 'Counted descent', instruction: 'Count the listener down.' }
    ])
  })

  it('keeps the tail of a quote that contains a separator', () => {
    const devices = parseDeviceLines(
      'DEVICE: Paired marks | Pause twice over. | down … | … and further'
    )

    expect(devices[0].quote).toBe('down … | … and further')
  })

  it('drops a device whose name is a sentence rather than a label', () => {
    const devices = parseDeviceLines(
      'DEVICE: This script tends to count the listener down while tying every ' +
        'number to a breath | Count down. | ten'
    )

    expect(devices).toEqual([])
  })

  it('drops a device with nothing said about it', () => {
    expect(parseDeviceLines('DEVICE: Counted descent')).toEqual([])
    expect(parseDeviceLines('DEVICE: | Count the listener down.')).toEqual([])
  })

  it('keeps the device but not an over-long quote, which is no longer verbatim once cut', () => {
    const devices = parseDeviceLines(
      `DEVICE: Counted descent | Count the listener down. | ${'word '.repeat(40)}`
    )

    expect(devices).toEqual([
      { name: 'Counted descent', instruction: 'Count the listener down.' }
    ])
  })

  it('keeps the first of a device named twice', () => {
    const devices = parseDeviceLines(
      [
        'DEVICE: Counted descent | Count the listener down. | ten',
        'DEVICE: counted descent | Count them up again. | one'
      ].join('\n')
    )

    expect(devices).toHaveLength(1)
    expect(devices[0].instruction).toBe('Count the listener down.')
  })

  it('stops at the limit it is given', () => {
    const reply = Array.from(
      { length: 20 },
      (_, index) => `DEVICE: Device ${index} | Do the ${index} thing. | quote ${index}`
    ).join('\n')

    expect(parseDeviceLines(reply)).toHaveLength(MAX_DEVICES)
    expect(parseDeviceLines(reply, 3)).toHaveLength(3)
  })

  it('reads back a line it wrote itself', () => {
    expect(parseDeviceLines(formatDeviceLine(device()))).toEqual([device()])
  })
})

describe('verifyDeviceQuotes', () => {
  const corpus = ['Settle back … and let the day go.\n\nTen … and down … nine.']

  it('keeps a quote the corpus really contains, however it was punctuated', () => {
    const verified = verifyDeviceQuotes(
      [device({ quote: 'ten …  and down' })],
      corpus
    )

    expect(verified[0].quote).toBe('ten …  and down')
  })

  it('drops a quote the corpus never contained, keeping the device', () => {
    const verified = verifyDeviceQuotes(
      [device({ quote: 'drift into the warm ocean of light' })],
      corpus
    )

    expect(verified).toEqual([
      { name: device().name, instruction: device().instruction }
    ])
  })

  it('leaves a device with no quote alone', () => {
    const bare = { name: 'Counted descent', instruction: 'Count them down.' }

    expect(verifyDeviceQuotes([bare], corpus)).toEqual([bare])
  })
})

describe('corpusSignature', () => {
  it('does not depend on the order the examples arrive in', () => {
    const one = example({ id: 'example_1' })
    const two = example({ id: 'example_2', content: 'b'.repeat(700) })

    expect(corpusSignature([one, two])).toBe(corpusSignature([two, one]))
  })

  it('changes when an example is edited, added or removed', () => {
    const base = [example({ id: 'example_1' })]
    const signature = corpusSignature(base)

    expect(corpusSignature([example({ id: 'example_1', content: 'a'.repeat(501) })]))
      .not.toBe(signature)
    expect(corpusSignature([...base, example({ id: 'example_2' })])).not.toBe(signature)
    expect(corpusSignature([])).not.toBe(signature)
  })
})

describe('areDevicesStale', () => {
  const examples = [example()]
  const set = (signature: string): CorpusDeviceSet => ({
    folder: 'Sleep',
    devices: [device()],
    model: 'fake-mini',
    generatedAt: 1,
    sources: 1,
    signature,
    generalised: false
  })

  it('is false while the folder is as it was when it was read', () => {
    expect(areDevicesStale(set(corpusSignature(examples)), examples)).toBe(false)
  })

  it('is true once the folder has moved on', () => {
    expect(areDevicesStale(set('0:none'), examples)).toBe(true)
  })

  it('says nothing about a folder that was never read', () => {
    expect(areDevicesStale(null, examples)).toBe(false)
  })
})

describe('deviceSourcesIn', () => {
  it('leaves out scripts too short to hold a device', () => {
    const sources = deviceSourcesIn([
      example({ id: 'example_1' }),
      example({ id: 'example_2', content: 'Close your eyes.' })
    ])

    expect(sources.map(entry => entry.id)).toEqual(['example_1'])
  })
})

describe('parseDeviceSets', () => {
  it('reads a stored set back', () => {
    const raw = JSON.stringify({
      Sleep: {
        folder: 'Sleep',
        devices: [device()],
        model: 'fake-mini',
        generatedAt: 5,
        sources: 3,
        signature: '3:abc'
      }
    })

    expect(parseDeviceSets(raw).Sleep.devices).toEqual([device()])
    expect(parseDeviceSets(raw).Sleep.sources).toBe(3)
  })

  it('drops a folder whose devices are malformed rather than prompting with them', () => {
    const raw = JSON.stringify({
      Sleep: { devices: [{ name: 'Counted descent' }] },
      Focus: { devices: 'a wall of prose' },
      Waking: { devices: [device()] }
    })

    expect(Object.keys(parseDeviceSets(raw))).toEqual(['Waking'])
  })

  it('returns nothing for missing or unreadable storage', () => {
    expect(parseDeviceSets(null)).toEqual({})
    expect(parseDeviceSets('{oh dear')).toEqual({})
    expect(parseDeviceSets('[]')).toEqual({})
  })
})

describe('stored per folder', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value) },
        removeItem: (key: string) => { store.delete(key) }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const set = (folder: string): CorpusDeviceSet => ({
    folder,
    devices: [device()],
    model: 'fake-mini',
    generatedAt: 5,
    sources: 2,
    signature: '2:abc',
    generalised: false
  })

  it('keeps each folder\'s devices apart', () => {
    saveCorpusDevices(set('Sleep'))
    saveCorpusDevices(set('Erotic'))

    expect(getCorpusDevices('Sleep')?.devices).toEqual([device()])
    expect(getCorpusDevices('Erotic')?.devices).toEqual([device()])
    expect(Object.keys(parseDeviceSets(store.get(CORPUS_DEVICES_KEY) ?? null)))
      .toEqual(['Sleep', 'Erotic'])
  })

  it('has nothing for a folder that was never read', () => {
    expect(getCorpusDevices('Sleep')).toBeNull()
  })

  it('clears one folder without touching the others', () => {
    saveCorpusDevices(set('Sleep'))
    saveCorpusDevices(set('Erotic'))

    clearCorpusDevices('Sleep')

    expect(getCorpusDevices('Sleep')).toBeNull()
    expect(getCorpusDevices('Erotic')).not.toBeNull()
  })

  it('files an unnamed folder where the corpus files unfiled examples', () => {
    saveCorpusDevices(set('  '))

    expect(getCorpusDevices('Unfiled')?.devices).toEqual([device()])
  })
})

// Story 8.21: what in a device belongs to the collection rather than to the
// craft, and what a generation gets when it asks for the move without it
describe('parseGenericLines', () => {
  const devices: CorpusDevice[] = [
    device(),
    {
      name: 'Abattoir drop',
      instruction: 'Say "abattoir" to drop them where the last count left off.',
      quote: 'abattoir … and down you go'
    }
  ]

  it('marks the device and keeps the move said without the word', () => {
    const marked = parseGenericLines(
      'GENERIC: Abattoir drop | Cue word drop | Say the cue word to drop them ' +
      'where the last count left off. | abattoir',
      devices
    )

    expect(marked[0]).toEqual(device())
    expect(marked[1].bound).toEqual(['abattoir'])
    expect(marked[1].generic).toEqual({
      name: 'Cue word drop',
      instruction: 'Say the cue word to drop them where the last count left off.'
    })
  })

  it('drops a line naming a device that is not there', () => {
    const marked = parseGenericLines(
      'GENERIC: Ocean drift | Plain drift | Drift them out. | ocean',
      devices
    )

    expect(marked).toEqual(devices)
  })

  it('drops a word the device it was claimed of does not contain', () => {
    const marked = parseGenericLines(
      'GENERIC: Abattoir drop | Cue word drop | Say the cue word. | mistletoe',
      devices
    )

    expect(marked[1].bound).toBeUndefined()
  })

  it('keeps the marking when the restatement still carries the word', () => {
    const marked = parseGenericLines(
      'GENERIC: Abattoir drop | Abattoir drop | Say "abattoir" to drop them. | abattoir',
      devices
    )

    expect(marked[1].bound).toEqual(['abattoir'])
    expect(marked[1].generic).toBeUndefined()
  })

  it('takes nothing from a reply that answered with prose', () => {
    expect(parseGenericLines('Nothing here belongs to this collection alone.', devices))
      .toEqual(devices)
  })
})

describe('containsTerm', () => {
  it('matches a word rather than a fragment of one', () => {
    expect(containsTerm('the ash settles', 'ash')).toBe(true)
    expect(containsTerm('the ashes settle', 'ash')).toBe(false)
    expect(containsTerm('you drop for Miss Vera', 'miss vera')).toBe(true)
    expect(containsTerm('you drop for her', 'Miss Vera')).toBe(false)
  })

  it('reads past the quotation marks a corpus happens to use', () => {
    expect(containsTerm('say \u201cabattoir\u201d and go', 'abattoir')).toBe(true)
  })
})

describe('devicesForFidelity', () => {
  const plain = device()
  const bound: CorpusDevice = {
    name: 'Abattoir drop',
    instruction: 'Say "abattoir" to drop them where the last count left off.',
    quote: 'abattoir … and down you go',
    bound: ['abattoir'],
    generic: {
      name: 'Cue word drop',
      instruction: 'Say the cue word to drop them where the last count left off.'
    }
  }

  it('sends the corpus as it was read when the run is faithful', () => {
    expect(devicesForFidelity([plain, bound], 'faithful')).toEqual([plain, bound])
  })

  it('sends the move without the word, and without the quote carrying it', () => {
    expect(devicesForFidelity([plain, bound], 'generic')).toEqual([
      plain,
      {
        name: 'Cue word drop',
        instruction: 'Say the cue word to drop them where the last count left off.'
      }
    ])
  })

  it('leaves out a device that could not be said without the word', () => {
    const unsaid: CorpusDevice = { ...bound, generic: undefined }

    expect(devicesForFidelity([plain, unsaid], 'generic')).toEqual([plain])
  })

  it('keeps another device\'s cue word out of the quote it hides in', () => {
    const borrowed: CorpusDevice = {
      name: 'Counted descent',
      instruction: 'Count them down on the out-breath.',
      quote: 'ten … nine … abattoir'
    }

    expect(devicesForFidelity([bound, borrowed], 'generic')).toContainEqual({
      name: 'Counted descent',
      instruction: 'Count them down on the out-breath.'
    })
  })

  it('sends a corpus with nothing particular in it unchanged either way', () => {
    expect(devicesForFidelity([plain], 'generic')).toEqual([plain])
  })
})

describe('boundTerms', () => {
  it('pools the words of the whole set, once each', () => {
    expect(boundTerms([
      { name: 'A', instruction: 'One.', bound: ['abattoir', 'Miss Vera'] },
      { name: 'B', instruction: 'Two.', bound: ['Abattoir'] },
      { name: 'C', instruction: 'Three.' }
    ])).toEqual(['abattoir', 'Miss Vera'])
  })
})

describe('parseStyleFidelity', () => {
  it('falls back to faithful for anything it does not recognise', () => {
    expect(parseStyleFidelity('generic')).toBe('generic')
    expect(parseStyleFidelity('faithful')).toBe('faithful')
    expect(parseStyleFidelity(undefined)).toBe('faithful')
    expect(parseStyleFidelity('loose')).toBe('faithful')
  })
})

describe('what the prompts carry', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value) },
        removeItem: (key: string) => { store.delete(key) }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the devices of the folder grounding generation with the exemplars', async () => {
    const { buildGenerationSystemPrompt, buildStyleCritiquePrompt } = await import('../prompts')
    const { buildLengthPlan } = await import('../scriptLength')
    const plan = buildLengthPlan()

    expect(buildGenerationSystemPrompt(plan, [])).not.toContain('## Devices from this corpus')

    saveCorpusDevices({
      folder: 'Unfiled',
      devices: [device()],
      model: 'fake-mini',
      generatedAt: 1,
      sources: 3,
      signature: '3:abc',
      generalised: false
    })

    expect(buildGenerationSystemPrompt(plan, [])).toContain('Breath counted down')
    // The review judges against them too, or it pulls every script back to
    // the rules the devices exist to counterweight
    expect(buildStyleCritiquePrompt('# A script')).toContain('Breath counted down')
  })

  // Story 8.21: the same folder, read two ways
  const boundSet = (): CorpusDeviceSet => ({
    folder: 'Unfiled',
    devices: [
      device(),
      {
        name: 'Abattoir drop',
        instruction: 'Say "abattoir" to drop them where the last count left off.',
        quote: 'abattoir … and down you go',
        bound: ['abattoir'],
        generic: {
          name: 'Cue word drop',
          instruction: 'Say the cue word to drop them where the last count left off.'
        }
      }
    ],
    model: 'fake-mini',
    generatedAt: 1,
    sources: 3,
    signature: '3:abc',
    generalised: true
  })

  it('sends the collection\'s own words with a faithful run and not a generic one', async () => {
    const { buildGenerationSystemPrompt } = await import('../prompts')
    const { buildLengthPlan } = await import('../scriptLength')
    const plan = buildLengthPlan()
    saveCorpusDevices(boundSet())

    store.set('styleFidelity', JSON.stringify('faithful'))
    const faithful = buildGenerationSystemPrompt(plan, [])
    expect(faithful).toContain('abattoir')
    expect(faithful).not.toContain('## Reading the examples')

    store.set('styleFidelity', JSON.stringify('generic'))
    const generic = buildGenerationSystemPrompt(plan, [])
    expect(generic).not.toContain('abattoir')
    expect(generic).toContain('Cue word drop')
    expect(generic).toContain('Breath counted down')
  })

  it('says what the exemplars are being read for when the run is generic', async () => {
    const { buildGenerationSystemPrompt } = await import('../prompts')
    const { buildLengthPlan } = await import('../scriptLength')
    const plan = buildLengthPlan()
    store.set('styleFidelity', JSON.stringify('generic'))

    const prompt = buildGenerationSystemPrompt(plan, [{ content: 'Ten … and down' }])

    // The note is about the exemplars, so it comes before them
    expect(prompt).toContain('## Reading the examples')
    expect(prompt.indexOf('## Reading the examples'))
      .toBeLessThan(prompt.indexOf('## Examples'))
  })

  it('holds the review to what the run was asked for', async () => {
    const { buildStyleCritiquePrompt } = await import('../prompts')
    saveCorpusDevices(boundSet())
    store.set('styleFidelity', JSON.stringify('generic'))

    const critique = buildStyleCritiquePrompt('# A script')

    expect(critique).not.toContain('abattoir')
    expect(critique).toContain('## What this script was asked for')
  })

  it('remembers what is particular to a folder across a save and a load', () => {
    saveCorpusDevices(boundSet())

    const stored = getCorpusDevices('Unfiled')
    expect(stored?.generalised).toBe(true)
    expect(stored?.devices[1].bound).toEqual(['abattoir'])
    expect(stored?.devices[1].generic?.name).toBe('Cue word drop')
    expect(areActiveDevicesGeneralised()).toBe(true)
  })

  it('knows a folder read before the marks existed from one with nothing to mark', () => {
    saveCorpusDevices({ ...boundSet(), generalised: false })

    expect(areActiveDevicesGeneralised()).toBe(false)
  })
})
