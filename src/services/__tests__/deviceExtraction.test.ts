import { describe, it, expect } from 'vitest'
import {
  createDeviceProgress,
  describeDeviceOutcome,
  describeDeviceStaleness,
  extractCorpusDevices
} from '../deviceExtraction'
import { corpusSignature } from '../corpusDevices'
import type { CorpusDeviceSet } from '../corpusDevices'
import type { ExampleRecord } from '../../types/example'
import type {
  UtilityCompletionRequest,
  UtilityModelService
} from '../utilityModelService'

// Two scripts long enough to be read for devices, sharing a phrase so a
// consolidation can honestly claim a device recurs
const SCRIPTS = [
  'Settle back and let your eyes close. Ten … and down … nine … and further ' +
    'down, each number carrying you deeper than the one before it. ' +
    'a'.repeat(400),
  'Let the chair take your weight. Ten … and down … nine … and the day goes ' +
    'with the breath you let out. ' +
    'b'.repeat(400)
]

const examples: ExampleRecord[] = SCRIPTS.map((content, index) => ({
  id: `example_${index + 1}`,
  title: `Script ${index + 1}`,
  tags: [],
  content,
  source: 'user'
}))

const EXTRACTION_REPLY = [
  'DEVICE: Counted descent | Counts the listener down on the out-breath. | Ten … and down',
  'DEVICE: Weight handed over | Gives the body to the chair before anything else. | let the chair take your weight'
].join('\n')

const CONSOLIDATION_REPLY = [
  'DEVICE: Counted descent | Count down on the out-breath, a number to a breath. | Ten … and down',
  'DEVICE: Weight handed over | Open by handing the body\'s weight to what it is resting on. | let the chair take your weight'
].join('\n')

// Records what it was asked and replies with whatever the test supplies
class FakeUtilityService implements UtilityModelService {
  readonly model = 'fake-mini'
  readonly isLive = true
  requests: UtilityCompletionRequest[] = []
  readonly replies: (request: UtilityCompletionRequest) => string

  constructor(replies: (request: UtilityCompletionRequest) => string) {
    this.replies = replies
  }

  async complete(request: UtilityCompletionRequest): Promise<string> {
    this.requests.push(request)
    const reply = this.replies(request)
    if (reply === '__throw__') throw new Error('the model was unreachable')
    return reply
  }
}

const replyPerJob = (request: UtilityCompletionRequest): string =>
  request.job === 'devices' ? EXTRACTION_REPLY : CONSOLIDATION_REPLY

describe('extractCorpusDevices', () => {
  it('reads every script, then consolidates what they share', async () => {
    const service = new FakeUtilityService(replyPerJob)

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(service.requests.map(request => request.job)).toEqual([
      'devices',
      'devices',
      'deviceDigest',
      'deviceGeneric'
    ])
    expect(outcome.sources).toBe(2)
    expect(outcome.observations).toBe(4)
    expect(outcome.set?.devices.map(entry => entry.name)).toEqual([
      'Counted descent',
      'Weight handed over'
    ])
    expect(outcome.set?.model).toBe('fake-mini')
    expect(outcome.set?.sources).toBe(2)
  })

  it('records the corpus it was read from, so a later change reads as stale', async () => {
    const service = new FakeUtilityService(replyPerJob)

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set?.signature).toBe(corpusSignature(examples))
  })

  it('shows the consolidation what each script said, script by script', async () => {
    const service = new FakeUtilityService(replyPerJob)

    await extractCorpusDevices('Sleep', examples, service)

    const consolidation = service.requests[2]
    expect(consolidation.user).toContain('### Script 1: Script 1')
    expect(consolidation.user).toContain('### Script 2: Script 2')
    expect(consolidation.system).toContain('2 hypnosis scripts')
  })

  it('leaves out a script too short to hold a device', async () => {
    const service = new FakeUtilityService(replyPerJob)
    const withSnippet = [...examples, {
      id: 'example_3',
      title: 'Snippet',
      tags: [],
      content: 'Close your eyes.',
      source: 'user' as const
    }]

    const outcome = await extractCorpusDevices('Sleep', withSnippet, service)

    expect(outcome.sources).toBe(2)
    expect(service.requests.filter(request => request.job === 'devices')).toHaveLength(2)
  })

  it('carries on when one script cannot be read', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'devices' && request.user.includes('Script 1')
        ? '__throw__'
        : replyPerJob(request)
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.observations).toBe(2)
    expect(outcome.set?.devices).toHaveLength(2)
  })

  it('stores nothing when no script gave up a device', async () => {
    const service = new FakeUtilityService(() => 'I could not find any devices in this script.')

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set).toBeNull()
    expect(outcome.observations).toBe(0)
    // Nothing was pooled, so the consolidation request is never sent
    expect(service.requests.every(request => request.job === 'devices')).toBe(true)
  })

  it('stores nothing when the consolidation answers with prose', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'devices'
        ? EXTRACTION_REPLY
        : 'These scripts share a gentle, permissive tone throughout.'
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set).toBeNull()
    expect(outcome.observations).toBe(4)
  })

  it('stores nothing when the consolidation cannot be reached', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'devices' ? EXTRACTION_REPLY : '__throw__'
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set).toBeNull()
  })

  it('keeps a device whose illustration was never in the corpus, without the quote', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'devices'
        ? EXTRACTION_REPLY
        : 'DEVICE: Counted descent | Count down on the out-breath. | drift out over the warm ocean'
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set?.devices).toEqual([
      { name: 'Counted descent', instruction: 'Count down on the out-breath.' }
    ])
  })

  it('names the script each request is sitting on, and says when it is consolidating', async () => {
    const service = new FakeUtilityService(replyPerJob)
    const started: string[] = []
    const finished: string[] = []
    let consolidating = 0

    await extractCorpusDevices('Sleep', examples, service, {
      onExampleStarted: id => started.push(id),
      onExampleFinished: id => finished.push(id),
      onConsolidating: () => { consolidating += 1 }
    })

    expect(started).toEqual(['example_1', 'example_2'])
    expect(finished).toEqual(['example_1', 'example_2'])
    expect(consolidating).toBe(1)
  })
})

// Story 8.21: the generalisation pass over the consolidated devices. The
// corpus below is written so a cue word of its own really is in it, since a
// term is only kept when it is found in the device that claimed it.
const BOUND_CONSOLIDATION = [
  'DEVICE: Counted descent | Count down on the out-breath, a number to a breath. | Ten … and down',
  'DEVICE: Abattoir drop | Say "abattoir" to drop them where the count left off. | Ten … and down'
].join('\n')

const GENERALISATION_REPLY =
  'GENERIC: Abattoir drop | Cue word drop | Say the cue word to drop them ' +
  'where the count left off. | abattoir'

const replyWithBinding = (request: UtilityCompletionRequest): string => {
  if (request.job === 'devices') return EXTRACTION_REPLY
  if (request.job === 'deviceDigest') return BOUND_CONSOLIDATION
  return GENERALISATION_REPLY
}

describe('the generalisation pass (story 8.21)', () => {
  it('marks what belongs to the collection and says the move without it', async () => {
    const service = new FakeUtilityService(replyWithBinding)

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set?.generalised).toBe(true)
    expect(outcome.set?.devices[0].bound).toBeUndefined()
    expect(outcome.set?.devices[1]).toEqual({
      name: 'Abattoir drop',
      instruction: 'Say "abattoir" to drop them where the count left off.',
      quote: 'Ten … and down',
      bound: ['abattoir'],
      generic: {
        name: 'Cue word drop',
        instruction: 'Say the cue word to drop them where the count left off.'
      }
    })
  })

  it('reads the devices themselves, since the devices are what a run is sent', async () => {
    const service = new FakeUtilityService(replyWithBinding)

    await extractCorpusDevices('Sleep', examples, service)

    const generalisation = service.requests[3]
    expect(generalisation.job).toBe('deviceGeneric')
    expect(generalisation.user).toContain('DEVICE: Abattoir drop |')
    expect(generalisation.user).not.toContain('Let the chair take your weight')
  })

  it('keeps the marking when the restatement still carries the word', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'deviceGeneric'
        ? 'GENERIC: Abattoir drop | Abattoir drop | Say "abattoir" to drop them. | abattoir'
        : replyWithBinding(request)
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set?.devices[1].bound).toEqual(['abattoir'])
    expect(outcome.set?.devices[1].generic).toBeUndefined()
  })

  it('drops a line whose words are not in the device it names', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'deviceGeneric'
        ? 'GENERIC: Counted descent | Cue word drop | Say the cue word. | mistletoe'
        : replyWithBinding(request)
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set?.devices.every(device => device.bound === undefined)).toBe(true)
    expect(outcome.set?.generalised).toBe(true)
  })

  it('keeps the devices, and says it never asked, when the request fails', async () => {
    const service = new FakeUtilityService(request =>
      request.job === 'deviceGeneric' ? '__throw__' : replyWithBinding(request)
    )

    const outcome = await extractCorpusDevices('Sleep', examples, service)

    expect(outcome.set?.devices).toHaveLength(2)
    expect(outcome.set?.generalised).toBe(false)
  })

  it('says when it is generalising, once the reading is done', async () => {
    const service = new FakeUtilityService(replyWithBinding)
    let generalising = 0

    await extractCorpusDevices('Sleep', examples, service, {
      onGeneralising: () => { generalising += 1 }
    })

    expect(generalising).toBe(1)
  })
})

describe('createDeviceProgress', () => {
  it('gives a row only to the scripts that will actually be read', () => {
    const rows = createDeviceProgress([
      ...examples,
      { id: 'example_3', title: 'Snippet', tags: [], content: 'Close your eyes.', source: 'user' }
    ])

    expect(rows.map(row => row.name)).toEqual(['Script 1', 'Script 2'])
    expect(rows.every(row => row.stage === 'queued')).toBe(true)
  })
})

describe('describeDeviceOutcome', () => {
  const set: CorpusDeviceSet = {
    folder: 'Sleep',
    devices: [{ name: 'Counted descent', instruction: 'Count them down.' }],
    model: 'fake-mini',
    generatedAt: 1,
    sources: 4,
    signature: '4:abc',
    generalised: false
  }

  it('says what was read and what was found', () => {
    expect(describeDeviceOutcome({ set, sources: 4, observations: 12 }, 'fake-mini'))
      .toBe('fake-mini read 4 scripts and found 1 device they share.')
  })

  it('says how much of what was found is the collection\'s own (story 8.21)', () => {
    const generalised: CorpusDeviceSet = { ...set, generalised: true }
    expect(describeDeviceOutcome({ set: generalised, sources: 4, observations: 12 }, 'fake-mini'))
      .toBe(
        'fake-mini read 4 scripts and found 1 device they share, none of them ' +
        'built on words of the collection\'s own.'
      )

    const bound: CorpusDeviceSet = {
      ...generalised,
      devices: [{ ...set.devices[0], bound: ['abattoir'] }]
    }
    expect(describeDeviceOutcome({ set: bound, sources: 4, observations: 12 }, 'fake-mini'))
      .toBe(
        'fake-mini read 4 scripts and found 1 device they share, 1 word in ' +
        'them the collection\'s own.'
      )
  })

  it('distinguishes finding nothing from finding nothing in common', () => {
    expect(describeDeviceOutcome({ set: null, sources: 4, observations: 0 }, 'fake-mini'))
      .toBe('fake-mini read 4 scripts and found no devices to describe them by.')
    expect(describeDeviceOutcome({ set: null, sources: 4, observations: 12 }, 'fake-mini'))
      .toBe('fake-mini read 4 scripts but found nothing the collection has in common.')
  })

  it('says so when there was nothing long enough to read', () => {
    expect(describeDeviceOutcome({ set: null, sources: 0, observations: 0 }, 'fake-mini'))
      .toBe('These scripts are too short to read for devices.')
  })
})

describe('describeDeviceStaleness', () => {
  it('says nothing while the devices still describe the folder', () => {
    expect(describeDeviceStaleness(false, 4)).toBeNull()
  })

  it('says what they were read from once the folder has moved on', () => {
    expect(describeDeviceStaleness(true, 1)).toContain('read from 1 script')
    expect(describeDeviceStaleness(true, 4)).toContain('read from 4 scripts')
  })
})
