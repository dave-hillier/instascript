import { describe, it, expect } from 'vitest'
import {
  BRIEF_QUESTIONS_SECTION_TITLE,
  buildBriefedPrompt,
  defaultBriefQuestions,
  parseBriefQuestions,
  requestBriefQuestions,
  type BriefAnswers,
  type BriefQuestion
} from '../briefQuestions'
import { buildBriefQuestionsPrompt } from '../prompts'
import type { ChatMessage, RegenerationRequest } from '../../types/conversation'

const wellFormedReply = [
  'Q: What trigger should the script plant?',
  '- "Sink" | One word drops them straight back down',
  '- "Eyes on me" | A phrase said aloud',
  '- No trigger | The session stands alone',
  '',
  'Q: Who is speaking, and who is listening?',
  '- A female hypnotist to a male subject | The standing default',
  '- A male hypnotist to a female subject | The reverse pairing'
].join('\n')

describe('parseBriefQuestions', () => {
  it('reads the asked-for format', () => {
    const questions = parseBriefQuestions(wellFormedReply)

    expect(questions).toHaveLength(2)
    expect(questions[0].id).toBe('q1')
    expect(questions[0].question).toBe('What trigger should the script plant?')
    expect(questions[0].options).toEqual([
      { label: '"Sink"', detail: 'One word drops them straight back down' },
      { label: '"Eyes on me"', detail: 'A phrase said aloud' },
      { label: 'No trigger', detail: 'The session stands alone' }
    ])
    expect(questions[1].options.map(option => option.label)).toEqual([
      'A female hypnotist to a male subject',
      'A male hypnotist to a female subject'
    ])
  })

  it('accepts an em dash instead of the pipe, and options without a gloss', () => {
    const questions = parseBriefQuestions([
      'Q: How should it end?',
      '* Awake and alert — counted up, carrying the suggestions',
      '* Drifting into sleep'
    ].join('\n'))

    expect(questions[0].options).toEqual([
      { label: 'Awake and alert', detail: 'counted up, carrying the suggestions' },
      { label: 'Drifting into sleep' }
    ])
  })

  it('does not split a hyphenated option label', () => {
    const questions = parseBriefQuestions([
      'Q: What tone?',
      '- Soft-spoken and slow',
      '- Cold and clinical'
    ].join('\n'))

    expect(questions[0].options[0]).toEqual({ label: 'Soft-spoken and slow' })
  })

  it('tolerates headings, numbering, emphasis and stray commentary', () => {
    const questions = parseBriefQuestions([
      'Here are the questions I would ask.',
      '## Question 1: **What should linger afterwards?**',
      'a) The voice pulls them back | Each listen drops them faster',
      'b) Nothing lasting | The effects end with the script',
      'That should be enough to go on.'
    ].join('\n'))

    expect(questions).toHaveLength(1)
    expect(questions[0].question).toBe('What should linger afterwards?')
    expect(questions[0].options).toHaveLength(2)
  })

  it('reads a question that lost its marker but kept its question mark', () => {
    const questions = parseBriefQuestions([
      'How explicit should the script be?',
      '- Suggestive throughout',
      '- Explicit once the listener is deep'
    ].join('\n'))

    expect(questions[0].question).toBe('How explicit should the script be?')
  })

  it('drops a question with fewer than two options', () => {
    const questions = parseBriefQuestions([
      'Q: A question with one answer?',
      '- The only option',
      'Q: A real question?',
      '- One',
      '- Two'
    ].join('\n'))

    expect(questions.map(question => question.question)).toEqual(['A real question?'])
    expect(questions[0].id).toBe('q1')
  })

  it('drops duplicate questions and duplicate options', () => {
    const questions = parseBriefQuestions([
      'Q: Which trigger?',
      '- "Sink"',
      '- "Sink"',
      '- "Drop"',
      'Q: which trigger?',
      '- Something else',
      '- Another thing'
    ].join('\n'))

    expect(questions).toHaveLength(1)
    expect(questions[0].options.map(option => option.label)).toEqual(['"Sink"', '"Drop"'])
  })

  it('caps a runaway questionnaire', () => {
    const reply = Array.from({ length: 12 }, (_, index) =>
      [`Q: Question ${index}?`, '- One', '- Two'].join('\n')
    ).join('\n')

    expect(parseBriefQuestions(reply)).toHaveLength(6)
  })

  it('caps the options within one question', () => {
    const reply = [
      'Q: Too many answers?',
      ...Array.from({ length: 10 }, (_, index) => `- Option ${index}`)
    ].join('\n')

    expect(parseBriefQuestions(reply)[0].options).toHaveLength(6)
  })

  it('returns nothing for a reply with no questionnaire in it', () => {
    expect(parseBriefQuestions('I cannot help with that request.')).toEqual([])
    expect(parseBriefQuestions('')).toEqual([])
  })
})

const questions: BriefQuestion[] = [
  {
    id: 'q1',
    question: 'What trigger should the script plant?',
    options: [
      { label: '"Sink"', detail: 'One word drops them straight down' },
      { label: 'No trigger' }
    ]
  },
  {
    id: 'q2',
    question: 'Who is speaking, and who is listening?',
    options: [{ label: 'A female hypnotist to a male subject' }, { label: 'The reverse' }]
  }
]

const brief = 'A slow script about giving up control.'

describe('buildBriefedPrompt', () => {
  it('leaves the brief alone when every question was left to the writer', () => {
    const answers: BriefAnswers = { q1: { kind: 'deferred' }, q2: { kind: 'deferred' } }

    expect(buildBriefedPrompt(brief, questions, answers)).toBe(brief)
  })

  it('leaves the brief alone when there were no questions', () => {
    expect(buildBriefedPrompt(`  ${brief}  `, [], {})).toBe(brief)
  })

  it('appends the chosen options, with the gloss that came with them', () => {
    const answers: BriefAnswers = {
      q1: { kind: 'option', value: '"Sink"' },
      q2: { kind: 'option', value: 'The reverse' }
    }

    expect(buildBriefedPrompt(brief, questions, answers)).toBe(
      `${brief}\n\n` +
      'Direction from the briefing questions:\n' +
      '- What trigger should the script plant? "Sink" (One word drops them straight down)\n' +
      '- Who is speaking, and who is listening? The reverse'
    )
  })

  it('carries a deferred question as the writer\'s own call once anything is answered', () => {
    const answers: BriefAnswers = {
      q1: { kind: 'custom', value: '  the word "heavy"  ' },
      q2: { kind: 'deferred' }
    }

    expect(buildBriefedPrompt(brief, questions, answers)).toBe(
      `${brief}\n\n` +
      'Direction from the briefing questions:\n' +
      '- What trigger should the script plant? the word "heavy"\n' +
      '- Who is speaking, and who is listening? your choice — decide what serves the script best'
    )
  })

  it('treats an empty custom answer as no answer at all', () => {
    const answers: BriefAnswers = { q1: { kind: 'custom', value: '   ' }, q2: { kind: 'deferred' } }

    expect(buildBriefedPrompt(brief, questions, answers)).toBe(brief)
  })

  it('answers a question whose option is no longer on offer with what was chosen', () => {
    const answers: BriefAnswers = { q1: { kind: 'option', value: 'A retired option' } }

    expect(buildBriefedPrompt(brief, questions, answers)).toContain(
      '- What trigger should the script plant? A retired option'
    )
  })
})

describe('defaultBriefQuestions', () => {
  it('asks about the trigger, what lingers, who is speaking and how it ends', () => {
    const fallback = defaultBriefQuestions()

    expect(fallback).toHaveLength(4)
    expect(fallback.every(question => question.options.length >= 3)).toBe(true)
    expect(new Set(fallback.map(question => question.id)).size).toBe(fallback.length)
  })
})

// A script service that replies with whatever it is given, recording the
// request so the marker and the message shape can be asserted
function stubService(reply: string | Error) {
  const seen: { request: RegenerationRequest; messages: ChatMessage[] }[] = []

  return {
    seen,
    async *regenerateSection(request: RegenerationRequest, messages: ChatMessage[]) {
      seen.push({ request, messages })
      if (reply instanceof Error) throw reply
      yield reply.slice(0, 10)
      yield reply.slice(10)
    }
  }
}

describe('requestBriefQuestions', () => {
  it('asks off the conversation, under the questions marker', async () => {
    const service = stubService(wellFormedReply)

    const result = await requestBriefQuestions(service, brief)

    expect(result.map(question => question.question)).toEqual([
      'What trigger should the script plant?',
      'Who is speaking, and who is listening?'
    ])
    expect(service.seen[0].request.sectionTitle).toBe(BRIEF_QUESTIONS_SECTION_TITLE)
    expect(service.seen[0].messages).toEqual([
      { role: 'user', content: buildBriefQuestionsPrompt(brief) }
    ])
  })

  it('falls back to the built-in questions when the reply is unusable', async () => {
    const service = stubService('I would rather not.')

    expect(await requestBriefQuestions(service, brief)).toEqual(defaultBriefQuestions())
  })

  it('lets a failed request through to the caller', async () => {
    const service = stubService(new Error('rejected key'))

    await expect(requestBriefQuestions(service, brief)).rejects.toThrow('rejected key')
  })
})

describe('buildBriefQuestionsPrompt', () => {
  it('carries the brief and fills in the requested shape', () => {
    const prompt = buildBriefQuestionsPrompt(`  ${brief}  `)

    expect(prompt).toContain(brief)
    expect(prompt).not.toMatch(/\{(min|max)(Questions|Options)\}/)
    expect(prompt).not.toContain('{brief}')
  })

  it('never substitutes placeholder-shaped text inside the brief', () => {
    const prompt = buildBriefQuestionsPrompt('Use {maxQuestions} triggers')

    expect(prompt).toContain('Use {maxQuestions} triggers')
  })
})
