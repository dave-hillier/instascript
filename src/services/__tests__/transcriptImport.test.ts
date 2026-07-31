import { describe, it, expect, vi } from 'vitest'
import {
  describeTranscriptImport,
  isUsableSplit,
  looksLikeRawTranscript,
  parseTranscriptSplit,
  renderSplitContent,
  splitSpecs,
  splitTranscript,
  type TranscriptSplit
} from '../transcriptImport'
import type { UtilityModelService } from '../utilityModelService'

// A transcript as it comes off a recording: speaker labels, timestamps, and
// the client answering back
const TRANSCRIPT = [
  '[00:00] Therapist: Okay, so make yourself comfortable there, and when you are ready let your eyes close.',
  '[00:12] Client: Mm hm. Yeah, my shoulders are heavy today, I have been carrying that meeting around all afternoon.',
  '[00:14] Therapist: Good. And just notice the weight of your body in the chair, the places where you are held.',
  'Let the breath out slowly, and again, slower still, until the breathing takes care of itself.',
  '[01:40] Therapist: And now that you are settled, we can go deeper. Each number I count takes you further down.',
  'Ten, drifting. Nine, heavier. Eight, further away from the room and everything in it.',
  '[04:10] Therapist: And down here, where things are quiet, you can begin to see the change already made.',
  'You are the person who sleeps easily. That is simply how it is now, and it stays true when you wake.',
  '[08:30] Therapist: So in a moment I will count you up. One, coming back. Two, aware of the room. Three, eyes open.',
  '[08:55] Client: Wow. That was quick.'
].join('\n')

const modelReply = [
  '# A Quiet Descent',
  '## Settling and induction',
  '> Brings attention to the body and lets the breathing take over.',
  'Okay, so make yourself comfortable there, and when you are ready let your eyes close.',
  '',
  'Good. And just notice the weight of your body in the chair, the places where you are held. Let the breath out slowly, and again, slower still, until the breathing takes care of itself.',
  '## Counting deeper',
  '> Deepens the trance with a descending count.',
  'And now that you are settled, we can go deeper. Each number I count takes you further down. Ten, drifting. Nine, heavier. Eight, further away from the room and everything in it.',
  '## The change made',
  '> States the change as something already true, and carries it into waking.',
  'And down here, where things are quiet, you can begin to see the change already made. You are the person who sleeps easily. That is simply how it is now, and it stays true when you wake.',
  '## Coming up',
  '> Returns to waking on a count of three.',
  'So in a moment I will count you up. One, coming back. Two, aware of the room. Three, eyes open.'
].join('\n')

const stubService = (reply: string, isLive = true): UtilityModelService => ({
  model: 'a small model',
  isLive,
  complete: vi.fn().mockResolvedValue(reply)
})

describe('parseTranscriptSplit', () => {
  it('reads the title, the section specs and the spoken words', () => {
    const split = parseTranscriptSplit(modelReply)

    expect(split?.title).toBe('A Quiet Descent')
    expect(split?.sections.map(section => section.title)).toEqual([
      'Settling and induction',
      'Counting deeper',
      'The change made',
      'Coming up'
    ])
    expect(split?.sections[1].prompt).toBe('Deepens the trance with a descending count.')
    expect(split?.sections[1].content.startsWith('And now that you are settled')).toBe(true)
    expect(split?.sections[1].content).not.toContain('>')
  })

  it('unwraps a code fence a model wrapped the reply in', () => {
    const split = parseTranscriptSplit('```markdown\n' + modelReply + '\n```')

    expect(split?.sections).toHaveLength(4)
  })

  it('keeps every line as content when a section has no spec line', () => {
    const split = parseTranscriptSplit('# T\n## One\nJust the words, no spec.')

    expect(split?.sections[0].prompt).toBe('')
    expect(split?.sections[0].content).toBe('Just the words, no spec.')
  })

  it('returns null when the reply has no sections at all', () => {
    expect(parseTranscriptSplit('I am sorry, I cannot help with that.')).toBeNull()
    expect(parseTranscriptSplit('   ')).toBeNull()
  })
})

describe('isUsableSplit', () => {
  const parsed = parseTranscriptSplit(modelReply) as TranscriptSplit

  it('accepts a split that kept the spoken words and specified every section', () => {
    expect(isUsableSplit(TRANSCRIPT, parsed)).toBe(true)
  })

  it('rejects a single section, which is the model declining to split', () => {
    expect(isUsableSplit(TRANSCRIPT, { title: 'T', sections: [parsed.sections[0]] })).toBe(false)
  })

  it('rejects a section left without a spec', () => {
    const sections = parsed.sections.map((section, index) =>
      index === 2 ? { ...section, prompt: '' } : section
    )

    expect(isUsableSplit(TRANSCRIPT, { title: 'T', sections })).toBe(false)
  })

  it('rejects a summary, which loses most of the session', () => {
    const summarised = parsed.sections.map(section => ({
      ...section,
      content: section.content.split(' ').slice(0, 16).join(' ')
    }))

    expect(isUsableSplit(TRANSCRIPT, { title: 'T', sections: summarised })).toBe(false)
  })

  it('rejects a split that grew the transcript, which means invented prose', () => {
    const padded = parsed.sections.map(section => ({
      ...section,
      content: `${section.content} ${section.content}`
    }))

    expect(isUsableSplit(TRANSCRIPT, { title: 'T', sections: padded })).toBe(false)
  })

  it('rejects a heading with nothing beneath it', () => {
    const sections = [...parsed.sections, { title: 'Afterwards', prompt: 'Closes.', content: 'Okay.' }]

    expect(isUsableSplit(TRANSCRIPT, { title: 'T', sections })).toBe(false)
  })
})

describe('looksLikeRawTranscript', () => {
  it('accepts a long unstructured transcript', () => {
    expect(looksLikeRawTranscript(TRANSCRIPT)).toBe(true)
  })

  it('leaves a script that already has sections alone', () => {
    expect(looksLikeRawTranscript(`${TRANSCRIPT}\n## Induction\nMore words here.`)).toBe(false)
  })

  it('does not spend a request on a fragment', () => {
    expect(looksLikeRawTranscript('Close your eyes.')).toBe(false)
  })
})

describe('renderSplitContent', () => {
  it('writes the example body as ordinary markdown, without the spec lines', () => {
    const split = parseTranscriptSplit(modelReply) as TranscriptSplit
    const content = renderSplitContent(split)

    expect(content.startsWith('# A Quiet Descent')).toBe(true)
    expect(content).toContain('## Counting deeper')
    expect(content).not.toContain('Deepens the trance with a descending count.')
    expect(content).toContain('Ten, drifting.')
  })

  it('carries the specs out separately, as the metadata for the sections', () => {
    const split = parseTranscriptSplit(modelReply) as TranscriptSplit

    expect(splitSpecs(split)[0]).toEqual({
      title: 'Settling and induction',
      prompt: 'Brings attention to the body and lets the breathing take over.'
    })
  })
})

describe('splitTranscript', () => {
  it('returns the split when the model obeys', async () => {
    const service = stubService(modelReply)

    const split = await splitTranscript('A Session', TRANSCRIPT, service)

    expect(split?.sections).toHaveLength(4)
    expect(service.complete).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'transcript', user: TRANSCRIPT })
    )
  })

  it('keeps the transcript when the model summarises instead of splitting', async () => {
    const service = stubService('# T\n## All of it\n> Everything.\nThey relaxed and then woke up.')

    expect(await splitTranscript('A Session', TRANSCRIPT, service)).toBeNull()
  })

  it('spends nothing when no provider is configured', async () => {
    const service = stubService(modelReply, false)

    expect(await splitTranscript('A Session', TRANSCRIPT, service)).toBeNull()
    expect(service.complete).not.toHaveBeenCalled()
  })

  it('keeps the transcript when the request fails', async () => {
    const service: UtilityModelService = {
      model: 'a small model',
      isLive: true,
      complete: vi.fn().mockRejectedValue(new Error('rate limited'))
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await splitTranscript('A Session', TRANSCRIPT, service)).toBeNull()
  })
})

describe('describeTranscriptImport', () => {
  it('says what happened to the transcripts', () => {
    expect(describeTranscriptImport({ split: 2, kept: 1 }, 'gpt-5-mini')).toBe(
      'gpt-5-mini split 2 into sections and left 1 unsplit.'
    )
  })

  it('says nothing when there is nothing to report', () => {
    expect(describeTranscriptImport({ split: 0, kept: 0 }, 'gpt-5-mini')).toBe('')
  })
})
