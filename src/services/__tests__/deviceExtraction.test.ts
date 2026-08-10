import { describe, it, expect } from 'vitest'
import {
  createDeviceProgress,
  describeDeviceOutcome,
  describeDeviceStaleness,
  extractCorpusDevices
} from '../deviceExtraction'
import { corpusSignature } from '../corpusDevices'
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
      'deviceDigest'
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
  const set = {
    folder: 'Sleep',
    devices: [{ name: 'Counted descent', instruction: 'Count them down.' }],
    model: 'fake-mini',
    generatedAt: 1,
    sources: 4,
    signature: '4:abc'
  }

  it('says what was read and what was found', () => {
    expect(describeDeviceOutcome({ set, sources: 4, observations: 12 }, 'fake-mini'))
      .toBe('fake-mini read 4 scripts and found 1 device they share.')
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
