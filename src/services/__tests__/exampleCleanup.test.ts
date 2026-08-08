import { describe, it, expect } from 'vitest'
import {
  cleanUpExample,
  cleanupJobsFor,
  createCleanupProgress,
  describeCleanupOutcome,
  EMPTY_CLEANUP_OUTCOME,
  isEmptyCleanup,
  isFaithfulSectioning,
  needsRetitling,
  needsSectioning,
  needsTagging,
  parseSuggestedTitle,
  recordCleanup,
  retitleContent
} from '../exampleCleanup'
import { parseTranscriptSplit } from '../transcriptImport'
import type { ExampleRecord } from '../../types/example'
import type {
  UtilityCompletionRequest,
  UtilityModelService
} from '../utilityModelService'

// Three stages of a short script, each long enough to be a section in its
// own right. The clean-up sectioning must give every word of them back.
const PARAGRAPHS = [
  'Settle back into the chair and let your eyes close whenever they are ready to, and let the day go with the next slow breath you let out.',
  'With every breath out you drift a little further down, and the sounds around you matter a little less than the quiet you are sinking into.',
  'In a moment you will come back up, bringing the calm with you, awake and clear and easy in yourself for the rest of the evening.'
]

const PLAIN_SCRIPT = PARAGRAPHS.join('\n\n')

const SECTIONED_REPLY = [
  '# Deep Rest',
  '## Settling',
  '> Invites the listener to close their eyes and let the day go.',
  PARAGRAPHS[0],
  '## Deepening',
  '> Ties the deepening to the out-breath.',
  PARAGRAPHS[1],
  '## Returning',
  '> Brings the listener back up carrying the calm.',
  PARAGRAPHS[2]
].join('\n')

const example = (overrides: Partial<ExampleRecord> = {}): ExampleRecord => ({
  id: 'example_1',
  title: 'Deep Rest',
  tags: ['non-explicit', 'sleep'],
  content: PLAIN_SCRIPT,
  source: 'user',
  ...overrides
})

// Records what it was asked and replies with whatever the test supplies
class FakeUtilityService implements UtilityModelService {
  readonly model = 'fake-mini'
  readonly isLive = true
  requests: UtilityCompletionRequest[] = []
  private replies: Partial<Record<UtilityCompletionRequest['job'], string | Error>>

  constructor(replies: Partial<Record<UtilityCompletionRequest['job'], string | Error>>) {
    this.replies = replies
  }

  async complete(request: UtilityCompletionRequest): Promise<string> {
    this.requests.push(request)
    const reply = this.replies[request.job]
    if (reply instanceof Error) throw reply
    return reply ?? ''
  }
}

describe('needsRetitling', () => {
  it('leaves a title someone wrote alone', () => {
    expect(needsRetitling('Deep Rest')).toBe(false)
    expect(needsRetitling('A Walk Down the Garden Path')).toBe(false)
  })

  it('catches the marks of the file a script arrived in', () => {
    expect(needsRetitling('deep_rest_final')).toBe(true)
    expect(needsRetitling('deep-rest-v2')).toBe(true)
    expect(needsRetitling('sleep script.md')).toBe(true)
    expect(needsRetitling('2023-04-18 recording')).toBe(true)
    expect(needsRetitling('03 deepening')).toBe(true)
    expect(needsRetitling('deep rest')).toBe(true)
    expect(needsRetitling('   ')).toBe(true)
  })

  it('catches a first line of prose standing in for a title', () => {
    expect(
      needsRetitling(
        'Settle back into the chair and let your eyes close whenever they are ready'
      )
    ).toBe(true)
  })
})

describe('needsSectioning', () => {
  it('wants sections for a script that has none', () => {
    expect(needsSectioning(example())).toBe(true)
  })

  it('wants specs for a script with headings but no specs', () => {
    const headed = example({
      content: PARAGRAPHS.map((text, index) => `## Stage ${index + 1}\n\n${text}`).join('\n\n')
    })
    expect(needsSectioning(headed)).toBe(true)
  })

  it('leaves an already sectioned example alone', () => {
    expect(
      needsSectioning(
        example({ sections: [{ title: 'Settling', prompt: 'Settles the listener.' }] })
      )
    ).toBe(false)
  })

  it('does not spend a request on a fragment', () => {
    expect(needsSectioning(example({ content: 'A note to myself.' }))).toBe(false)
  })
})

describe('needsTagging', () => {
  it('wants tags for an untagged example', () => {
    expect(needsTagging(example({ tags: [] }))).toBe(true)
  })

  it('wants the standard vocabulary on an example that predates it', () => {
    expect(needsTagging(example({ tags: ['sleep', 'relaxation'] }))).toBe(true)
  })

  it('leaves an example tagged the way the corpus tags things now', () => {
    expect(needsTagging(example({ tags: ['explicit', 'sleep'] }))).toBe(false)
  })
})

describe('cleanupJobsFor', () => {
  it('lists the jobs in the order they run', () => {
    expect(cleanupJobsFor(example({ title: 'deep_rest', tags: [] }))).toEqual([
      'retitling',
      'sectioning',
      'tagging'
    ])
  })

  it('is empty for an example with nothing to gain', () => {
    expect(
      cleanupJobsFor(
        example({
          title: 'Deep Rest',
          tags: ['non-explicit', 'sleep'],
          sections: [{ title: 'Settling', prompt: 'Settles the listener.' }]
        })
      )
    ).toEqual([])
  })
})

describe('parseSuggestedTitle', () => {
  it('reads the single line the prompt asks for', () => {
    expect(parseSuggestedTitle('An Evening Descent')).toBe('An Evening Descent')
  })

  it('takes off the wrapping a smaller model adds', () => {
    expect(parseSuggestedTitle('"An Evening Descent"')).toBe('An Evening Descent')
    expect(parseSuggestedTitle('# An Evening Descent')).toBe('An Evening Descent')
    expect(parseSuggestedTitle('Title: An Evening Descent.')).toBe('An Evening Descent')
    expect(parseSuggestedTitle('```\nAn Evening Descent\n```')).toBe('An Evening Descent')
  })

  it('rejects a reply that is not a title', () => {
    expect(parseSuggestedTitle('')).toBe('')
    expect(parseSuggestedTitle('...')).toBe('')
    expect(
      parseSuggestedTitle(
        'This script takes the listener down through a long staircase and then brings them back up again feeling rested'
      )
    ).toBe('')
  })
})

describe('retitleContent', () => {
  it('brings a body that states its title in line with the new one', () => {
    expect(retitleContent('# deep_rest\n\nSettle back.', 'Deep Rest')).toBe(
      '# Deep Rest\n\nSettle back.'
    )
  })

  it('leaves a body that never states its title alone', () => {
    expect(retitleContent('Settle back.', 'Deep Rest')).toBe('Settle back.')
    expect(retitleContent('## Settling\n\nSettle back.', 'Deep Rest')).toBe(
      '## Settling\n\nSettle back.'
    )
  })
})

describe('isFaithfulSectioning', () => {
  const split = () => parseTranscriptSplit(SECTIONED_REPLY)!

  it('accepts a split that kept every word', () => {
    expect(isFaithfulSectioning(PLAIN_SCRIPT, split())).toBe(true)
  })

  it('accepts a split of a script that already carried headings', () => {
    const headed = PARAGRAPHS.map((text, index) => `## Stage ${index + 1}\n\n${text}`).join('\n\n')
    expect(isFaithfulSectioning(headed, split())).toBe(true)
  })

  it('rejects a split that summarised the script', () => {
    const summarised = split()
    summarised.sections[1].content = 'They go deeper with every breath they let out.'
    expect(isFaithfulSectioning(PLAIN_SCRIPT, summarised)).toBe(false)
  })

  it('rejects a split that wrote prose of its own', () => {
    const padded = split()
    padded.sections[2].content += ` ${PARAGRAPHS[0]}`
    expect(isFaithfulSectioning(PLAIN_SCRIPT, padded)).toBe(false)
  })

  it('rejects a split that declined to divide the script', () => {
    const single = split()
    single.sections = single.sections.slice(0, 1)
    expect(isFaithfulSectioning(PLAIN_SCRIPT, single)).toBe(false)
  })

  it('rejects a section left without a spec', () => {
    const unspecified = split()
    unspecified.sections[0].prompt = ''
    expect(isFaithfulSectioning(PLAIN_SCRIPT, unspecified)).toBe(false)
  })
})

describe('cleanUpExample', () => {
  it('runs only the jobs the example needs', async () => {
    const service = new FakeUtilityService({ tagging: 'sleep, deepening' })
    await cleanUpExample(
      example({
        title: 'Deep Rest',
        tags: ['sleep'],
        sections: [{ title: 'Settling', prompt: 'Settles the listener.' }]
      }),
      service,
      []
    )

    expect(service.requests.map(request => request.job)).toEqual(['tagging'])
  })

  it('retitles, sections and tags in one pass', async () => {
    const service = new FakeUtilityService({
      retitling: 'An Evening Descent',
      sectioning: SECTIONED_REPLY,
      tagging: 'non-explicit, any subject, sleep'
    })

    const cleanup = await cleanUpExample(
      example({ title: 'deep_rest_final', tags: [] }),
      service,
      []
    )

    expect(service.requests.map(request => request.job)).toEqual([
      'retitling',
      'sectioning',
      'tagging'
    ])
    expect(cleanup.title).toBe('An Evening Descent')
    expect(cleanup.sections).toEqual([
      { title: 'Settling', prompt: 'Invites the listener to close their eyes and let the day go.' },
      { title: 'Deepening', prompt: 'Ties the deepening to the out-breath.' },
      { title: 'Returning', prompt: 'Brings the listener back up carrying the calm.' }
    ])
    // The body keeps the new title rather than the one the sectioning echoed
    expect(cleanup.content?.startsWith('# An Evening Descent')).toBe(true)
    for (const paragraph of PARAGRAPHS) {
      expect(cleanup.content).toContain(paragraph)
    }
    expect(cleanup.tags).toEqual(['non-explicit', 'any subject', 'sleep'])
    expect(isEmptyCleanup(cleanup)).toBe(false)
  })

  it('keeps the tags the example already carried behind the suggestions', async () => {
    const service = new FakeUtilityService({ tagging: 'explicit, female subject' })
    const cleanup = await cleanUpExample(
      example({
        tags: ['jealousy', 'sleep'],
        sections: [{ title: 'Settling', prompt: 'Settles the listener.' }]
      }),
      service,
      []
    )

    expect(service.requests.map(request => request.job)).toEqual(['tagging'])
    expect(cleanup.tags).toEqual(['explicit', 'female subject', 'jealousy', 'sleep'])
  })

  it('keeps the example as it was when the replies are unusable', async () => {
    const service = new FakeUtilityService({
      retitling: 'Here is a title that runs on and on and says far more than a title ever should',
      sectioning: 'I could not find any sections in this script.',
      tagging: ''
    })

    const cleanup = await cleanUpExample(
      example({ title: 'deep_rest_final', tags: [] }),
      service,
      []
    )

    expect(isEmptyCleanup(cleanup)).toBe(true)
    expect(cleanup.title).toBeUndefined()
    expect(cleanup.content).toBeUndefined()
    expect(cleanup.tags).toBeUndefined()
  })

  it('lets the other jobs finish when one request fails', async () => {
    const service = new FakeUtilityService({
      retitling: new Error('rate limited'),
      sectioning: SECTIONED_REPLY,
      tagging: 'non-explicit, sleep'
    })

    const cleanup = await cleanUpExample(
      example({ title: 'deep_rest_final', tags: [] }),
      service,
      []
    )

    expect(cleanup.retitled).toBeUndefined()
    expect(cleanup.sectioned).toBe(true)
    expect(cleanup.tagged).toBe(true)
    // The sectioning kept the title the example still has
    expect(cleanup.content?.startsWith('# deep_rest_final')).toBe(true)
  })

  it('names each job as it starts, for the meter', async () => {
    const service = new FakeUtilityService({
      retitling: 'An Evening Descent',
      sectioning: SECTIONED_REPLY,
      tagging: 'non-explicit, sleep'
    })
    const stages: string[] = []

    await cleanUpExample(example({ title: 'deep_rest_final', tags: [] }), service, [], {
      onJobStarted: job => stages.push(job)
    })

    expect(stages).toEqual(['retitling', 'sectioning', 'tagging'])
  })
})

describe('createCleanupProgress', () => {
  it('gives each example a row of its own, named by its title', () => {
    expect(
      createCleanupProgress([
        example({ id: 'example_1', title: 'deep_rest' }),
        example({ id: 'example_2', title: 'morning light' })
      ])
    ).toEqual([
      {
        id: 'example_1',
        path: 'deep_rest',
        name: 'deep_rest',
        stage: 'queued',
        exampleId: 'example_1'
      },
      {
        id: 'example_2',
        path: 'morning light',
        name: 'morning light',
        stage: 'queued',
        exampleId: 'example_2'
      }
    ])
  })
})

describe('describeCleanupOutcome', () => {
  it('says what was done', () => {
    expect(
      describeCleanupOutcome(
        { retitled: 2, sectioned: 1, tagged: 3, unchanged: 0 },
        'gpt-5-mini'
      )
    ).toBe('gpt-5-mini retitled 2, divided 1 into sections and tagged 3.')
  })

  it('accounts for the examples it could not improve', () => {
    expect(
      describeCleanupOutcome({ retitled: 0, sectioned: 0, tagged: 1, unchanged: 2 }, 'fake-mini')
    ).toBe('fake-mini tagged 1 and left 2 unchanged.')
  })

  it('says nothing when there is nothing to say', () => {
    expect(describeCleanupOutcome(EMPTY_CLEANUP_OUTCOME, 'fake-mini')).toBe('')
  })
})

describe('recordCleanup', () => {
  it('counts what each example came back with', () => {
    const first = recordCleanup(EMPTY_CLEANUP_OUTCOME, { retitled: true, tagged: true })
    const second = recordCleanup(first, {})

    expect(second).toEqual({ retitled: 1, sectioned: 0, tagged: 1, unchanged: 1 })
  })
})
