import { describe, it, expect } from 'vitest'
import {
  MAX_SUGGESTED_TAGS,
  countAddressMarkers,
  describeImportAssist,
  enhanceImportedExample,
  importAssistJobsFor,
  isFaithfulFormatting,
  isFaithfulVoicing,
  needsDirectAddress,
  needsMarkdownFormatting,
  parseSuggestedTags,
  rewriteForDirectAddress,
  rewriteTokenBudget,
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

  it('announces each job as it starts, so the import meter can name the stage', async () => {
    const service = new FakeUtilityService({
      formatting: new Error('rate limited'),
      tagging: 'sleep'
    })
    const jobs: string[] = []

    await enhanceImportedExample(example(), service, [], {
      onJobStarted: job => jobs.push(job)
    })

    // Announced before the request, so a failing job is still shown as run
    expect(jobs).toEqual(['formatting', 'tagging'])
  })

  it('announces only the jobs an example actually needs', async () => {
    const service = new FakeUtilityService({ tagging: 'sleep' })
    const jobs: string[] = []

    await enhanceImportedExample(
      example({ content: `# Deep Rest\n\n${PLAIN_SCRIPT}` }),
      service,
      [],
      { onJobStarted: job => jobs.push(job) }
    )

    expect(jobs).toEqual(['tagging'])
  })

  it('returns nothing when both jobs fail', async () => {
    const service = new FakeUtilityService({
      formatting: new Error('offline'),
      tagging: new Error('offline')
    })

    expect(await enhanceImportedExample(example(), service, [])).toEqual({})
  })
})

// A script written about someone else, spoken to a title
const THIRD_PERSON_SCRIPT = [
  '## Descent',
  'She feels her eyelids grow heavy, and she lets herself sink.',
  'Deeper now, dropping for Mistress, because her Master asked it of her.'
].join('\n')

const VOICED_SCRIPT = [
  '## Descent',
  'You feel your eyelids grow heavy, and you let yourself sink.',
  'Deeper now, dropping for me, because I asked it of you.'
].join('\n')

describe('countAddressMarkers', () => {
  it('counts third-person narration and titles of address', () => {
    expect(countAddressMarkers(THIRD_PERSON_SCRIPT)).toBeGreaterThan(5)
  })

  it('leaves a script that already speaks to the listener alone', () => {
    expect(countAddressMarkers(VOICED_SCRIPT)).toBe(0)
    expect(needsDirectAddress(VOICED_SCRIPT)).toBe(false)
  })

  it('does not count the plural pronouns a second-person script uses', () => {
    expect(countAddressMarkers('Let your thoughts come, and let them go.')).toBe(0)
  })
})

describe('isFaithfulVoicing', () => {
  it('accepts a rewrite that changed the person and kept the script', () => {
    expect(isFaithfulVoicing(THIRD_PERSON_SCRIPT, VOICED_SCRIPT)).toBe(true)
  })

  it('rejects a reply that changed nothing', () => {
    expect(isFaithfulVoicing(THIRD_PERSON_SCRIPT, THIRD_PERSON_SCRIPT)).toBe(false)
  })

  it('rejects a summary', () => {
    expect(isFaithfulVoicing(THIRD_PERSON_SCRIPT, '## Descent\nYou sink.')).toBe(false)
  })

  it('rejects a rewrite that restructured the headings', () => {
    const restructured = VOICED_SCRIPT.replace('## Descent', '## Descent\n\n## Deeper')
    expect(isFaithfulVoicing(THIRD_PERSON_SCRIPT, restructured)).toBe(false)
  })

  it('rejects an empty reply', () => {
    expect(isFaithfulVoicing(THIRD_PERSON_SCRIPT, '   ')).toBe(false)
  })
})

describe('rewriteForDirectAddress', () => {
  it('asks the utility model and returns a faithful rewrite', async () => {
    const service = new FakeUtilityService({ voicing: VOICED_SCRIPT })

    expect(await rewriteForDirectAddress(THIRD_PERSON_SCRIPT, service)).toBe(VOICED_SCRIPT)
    expect(service.requests[0].job).toBe('voicing')
  })

  it('asks for room to reproduce the whole script', async () => {
    const long = `${THIRD_PERSON_SCRIPT}\n${'she drifts down and down. '.repeat(3000)}`
    const service = new FakeUtilityService({ voicing: '' })

    await rewriteForDirectAddress(long, service)

    expect(service.requests[0].maxOutputTokens).toBe(rewriteTokenBudget(long))
    expect(service.requests[0].maxOutputTokens).toBeGreaterThan(4096)
  })

  it('keeps the script when the reply cannot be trusted', async () => {
    const service = new FakeUtilityService({ voicing: 'Sure! Here is a shorter version.' })

    expect(await rewriteForDirectAddress(THIRD_PERSON_SCRIPT, service)).toBeNull()
  })

  it('costs nothing when the script already speaks to the listener', async () => {
    const service = new FakeUtilityService({ voicing: VOICED_SCRIPT })

    expect(await rewriteForDirectAddress(VOICED_SCRIPT, service)).toBeNull()
    expect(service.requests).toEqual([])
  })

  it('keeps the script when the request fails', async () => {
    const service = new FakeUtilityService({ voicing: new Error('offline') })

    expect(await rewriteForDirectAddress(THIRD_PERSON_SCRIPT, service)).toBeNull()
  })
})

describe('the direct-address pass inside an import', () => {
  it('runs only when the import asked for it', async () => {
    const service = new FakeUtilityService({ voicing: VOICED_SCRIPT, tagging: 'sleep' })
    const imported = example({ content: THIRD_PERSON_SCRIPT })

    const untouched = await enhanceImportedExample(imported, service, [])
    expect(untouched.content).toBeUndefined()
    expect(untouched.voiced).toBeUndefined()

    const rewritten = await enhanceImportedExample(imported, service, [], { voicing: true })
    expect(rewritten.content).toBe(VOICED_SCRIPT)
    expect(rewritten.voiced).toBe(true)
  })

  it('rewrites before formatting, so the layout is of the text that is stored', async () => {
    const plainThirdPerson = `She settles back. ${'She lets each breath carry her further down. '.repeat(20)}`
    const voiced = `You settle back. ${'You let each breath carry you further down. '.repeat(20)}`
    const service = new FakeUtilityService({
      voicing: voiced,
      formatting: `# Deep Rest\n\n## Settling\n${voiced}`,
      tagging: 'sleep'
    })
    const jobs: string[] = []

    const enhancement = await enhanceImportedExample(
      example({ content: plainThirdPerson }),
      service,
      [],
      { voicing: true, onJobStarted: job => jobs.push(job) }
    )

    expect(jobs).toEqual(['voicing', 'formatting', 'tagging'])
    // The formatting request saw the rewritten text, not the import
    expect(service.requests[1].user).toBe(voiced.trim())
    expect(enhancement.content).toContain('## Settling')
    expect(enhancement.voiced).toBe(true)
    expect(enhancement.formatted).toBe(true)
  })

  it('lists the jobs an example needs before any request is made', () => {
    const plain = example({ content: THIRD_PERSON_SCRIPT, tags: ['sleep'] })

    expect(importAssistJobsFor(plain)).toEqual([])
    expect(importAssistJobsFor(plain, { voicing: true })).toEqual(['voicing'])
    expect(importAssistJobsFor(example(), { voicing: true })).toEqual(['formatting', 'tagging'])
  })
})

describe('describeImportAssist', () => {
  it('names the model and what it did', () => {
    expect(describeImportAssist({ tagged: 2, formatted: 1, voiced: 0 }, 'gpt-5-nano')).toBe(
      'gpt-5-nano formatted 1 as markdown and tagged 2.'
    )
  })

  it('reads as a list once all three passes have done something', () => {
    expect(describeImportAssist({ tagged: 2, formatted: 1, voiced: 3 }, 'gpt-5-nano')).toBe(
      'gpt-5-nano rewrote 3 into direct address, formatted 1 as markdown and tagged 2.'
    )
  })

  it('says nothing when nothing was applied', () => {
    expect(describeImportAssist({ tagged: 0, formatted: 0, voiced: 0 }, 'gpt-5-nano')).toBe('')
  })
})
