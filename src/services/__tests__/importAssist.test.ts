import { describe, it, expect } from 'vitest'
import {
  MAX_SUGGESTED_TAGS,
  describeImportAssist,
  enhanceImportedExample,
  isFaithfulFormatting,
  needsMarkdownFormatting,
  parseSuggestedTags,
  stripCodeFence
} from '../importAssist'
import type { ExampleRecord } from '../../types/example'
import type {
  UtilityCompletionRequest,
  UtilityModelService
} from '../utilityModelService'

const PLAIN_SCRIPT = `Settle back and let your eyes close. ${'Breathe slowly and let each breath carry you further down. '.repeat(20)}`.trim()

const example = (overrides: Partial<ExampleRecord> = {}): ExampleRecord => ({
  id: 'example_1',
  title: 'Deep Rest',
  tags: [],
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

describe('parseSuggestedTags', () => {
  it('reads the comma separated line the prompt asks for', () => {
    expect(parseSuggestedTags('sleep, anxiety relief, progressive relaxation')).toEqual([
      'sleep',
      'anxiety relief',
      'progressive relaxation'
    ])
  })

  it('tolerates a bulleted list, a preamble, quotes and casing', () => {
    const reply = 'Tags: "Sleep"\n- Confidence\n* deep relaxation.\n1. Focus'
    expect(parseSuggestedTags(reply)).toEqual(['sleep', 'confidence', 'deep relaxation', 'focus'])
  })

  it('drops duplicates and sentence-length answers', () => {
    const reply = 'sleep, Sleep, this script is intended for listeners who want to sleep better'
    expect(parseSuggestedTags(reply)).toEqual(['sleep'])
  })

  it('caps how many tags one suggestion can add', () => {
    const reply = Array.from({ length: 12 }, (_, index) => `tag${index}`).join(', ')
    expect(parseSuggestedTags(reply)).toHaveLength(MAX_SUGGESTED_TAGS)
  })
})

describe('needsMarkdownFormatting', () => {
  it('is true for a long plain-text script with no headings', () => {
    expect(needsMarkdownFormatting(PLAIN_SCRIPT)).toBe(true)
  })

  it('is false once the script already carries headings', () => {
    expect(needsMarkdownFormatting(`# Deep Rest\n\n${PLAIN_SCRIPT}`)).toBe(false)
  })

  it('is false for a snippet too short to have structure', () => {
    expect(needsMarkdownFormatting('Close your eyes.')).toBe(false)
  })
})

describe('stripCodeFence', () => {
  it('unwraps a fenced reply', () => {
    expect(stripCodeFence('```markdown\n# Title\n\nBody\n```')).toBe('# Title\n\nBody')
  })

  it('leaves an unfenced reply alone', () => {
    expect(stripCodeFence('  # Title\n\nBody  ')).toBe('# Title\n\nBody')
  })
})

describe('isFaithfulFormatting', () => {
  it('accepts headings and paragraph breaks added around the same words', () => {
    const formatted = `# Deep Rest\n\n## Induction\n\n${PLAIN_SCRIPT}`
    expect(isFaithfulFormatting(PLAIN_SCRIPT, formatted)).toBe(true)
  })

  it('rejects a summary dressed up as formatting', () => {
    const formatted = '# Deep Rest\n\n## Induction\n\nThe listener relaxes and goes deeper.'
    expect(isFaithfulFormatting(PLAIN_SCRIPT, formatted)).toBe(false)
  })

  it('rejects a reply that invented a commentary section', () => {
    const formatted = `# Deep Rest\n\n${PLAIN_SCRIPT}\n\n${PLAIN_SCRIPT}`
    expect(isFaithfulFormatting(PLAIN_SCRIPT, formatted)).toBe(false)
  })

  it('rejects a reply that added no structure', () => {
    expect(isFaithfulFormatting(PLAIN_SCRIPT, PLAIN_SCRIPT)).toBe(false)
  })
})

describe('enhanceImportedExample', () => {
  it('formats and tags an untagged plain-text import', async () => {
    const formatted = `# Deep Rest\n\n## Induction\n\n${PLAIN_SCRIPT}`
    const service = new FakeUtilityService({ formatting: formatted, tagging: 'sleep, deep relaxation' })

    const enhancement = await enhanceImportedExample(example(), service, ['sleep'])

    expect(enhancement.content).toBe(formatted)
    expect(enhancement.tags).toEqual(['sleep', 'deep relaxation'])
    expect(service.requests.map(request => request.job)).toEqual(['formatting', 'tagging'])
    // Tagging reads the formatted text, not the text as imported
    expect(service.requests[1].user).toContain('## Induction')
  })

  it('leaves an example that already has tags and headings untouched', async () => {
    const service = new FakeUtilityService({})

    const enhancement = await enhanceImportedExample(
      example({ tags: ['sleep'], content: `# Deep Rest\n\n${PLAIN_SCRIPT}` }),
      service,
      []
    )

    expect(enhancement).toEqual({})
    expect(service.requests).toHaveLength(0)
  })

  it('keeps the original content when the model rewrites rather than formats', async () => {
    const service = new FakeUtilityService({
      formatting: '# Deep Rest\n\nA short summary of the script.',
      tagging: 'sleep'
    })

    const enhancement = await enhanceImportedExample(example(), service, [])

    expect(enhancement.content).toBeUndefined()
    expect(enhancement.tags).toEqual(['sleep'])
  })

  it('still tags when the formatting request fails', async () => {
    const service = new FakeUtilityService({
      formatting: new Error('rate limited'),
      tagging: 'sleep'
    })

    const enhancement = await enhanceImportedExample(example(), service, [])

    expect(enhancement.content).toBeUndefined()
    expect(enhancement.tags).toEqual(['sleep'])
  })

  it('returns nothing when both jobs fail', async () => {
    const service = new FakeUtilityService({
      formatting: new Error('offline'),
      tagging: new Error('offline')
    })

    expect(await enhanceImportedExample(example(), service, [])).toEqual({})
  })
})

describe('describeImportAssist', () => {
  it('names the model and what it did', () => {
    expect(describeImportAssist({ tagged: 2, formatted: 1 }, 'gpt-5-nano')).toBe(
      'gpt-5-nano tagged 2 and formatted 1 as markdown.'
    )
  })

  it('says nothing when nothing was applied', () => {
    expect(describeImportAssist({ tagged: 0, formatted: 0 }, 'gpt-5-nano')).toBe('')
  })
})
