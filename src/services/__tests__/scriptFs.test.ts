import { describe, it, expect } from 'vitest'
import type { Generation, RawConversation } from '../../types/conversation'
import {
  buildScriptFs,
  listScriptFsPaths,
  readScriptFsPath,
  renderScriptFsTree,
  resolveSectionPath
} from '../scriptFs'
import { getOutlineGenerationPrompt, getSystemPrompt } from '../prompts'

const makeGeneration = (response: string, timestamp: number, overrides: Partial<Generation> = {}): Generation => ({
  messages: [],
  response,
  timestamp,
  ...overrides
})

const makeConversation = (generations: Generation[]): RawConversation => ({
  id: 'conv-1',
  scriptId: 'script-1',
  generations,
  createdAt: 0,
  updatedAt: 0
})

const words = (count: number): string => Array.from({ length: count }, () => 'word').join(' ')

const outlineV1 = `# The Quiet Descent
## Induction
Settle the listener.
## Deepening
Take them down.
## Escalation
Bring them to the edge.`

describe('buildScriptFs', () => {
  it('takes the mount table from the latest outline, superseding the first', () => {
    const conversation = makeConversation([
      makeGeneration('# Old Title\n## Alpha\nAlpha spec.\n## Beta\nBeta spec.', 1),
      makeGeneration('## Alpha\nAlpha body.', 2),
      makeGeneration('## Beta\nBeta body.', 3),
      makeGeneration('# New Title\n## Alpha\nAlpha spec.\n## Gamma\nGamma spec.', 4)
    ])

    const tree = buildScriptFs(conversation)

    expect(tree.title).toBe('New Title')
    expect(tree.sections.map(section => section.title)).toEqual(['Alpha', 'Gamma'])
    expect(tree.unmounted).toEqual([{ title: 'Beta', content: 'Beta body.' }])
  })

  it('reads the brief from the first user message of the first generation', () => {
    const conversation = makeConversation([
      makeGeneration(outlineV1, 1, {
        messages: [
          { role: 'system', content: 'You are a writer.' },
          { role: 'user', content: 'A script about walking through a winter forest.' }
        ]
      })
    ])

    expect(buildScriptFs(conversation).brief).toBe('A script about walking through a winter forest.')
  })

  it('strips the appended outline-generation template from the brief', () => {
    const conversation = makeConversation([
      makeGeneration(outlineV1, 1, {
        messages: [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: `Write me a hypnosis script about rain.\n\n${getOutlineGenerationPrompt()}` }
        ]
      })
    ])

    const tree = buildScriptFs(conversation)

    expect(tree.brief).toBe('Write me a hypnosis script about rain.')
    expect(readScriptFsPath(tree, '/brief.md')).toBe('Write me a hypnosis script about rain.')
  })

  it('numbers section paths in gaps of ten and slugs the titles', () => {
    const tree = buildScriptFs(makeConversation([makeGeneration(outlineV1, 1)]))

    expect(tree.sections.map(section => section.path)).toEqual([
      '/sections/010-induction',
      '/sections/020-deepening',
      '/sections/030-escalation'
    ])
    expect(tree.sections.map(section => section.order)).toEqual([10, 20, 30])
  })

  it('suffixes colliding slugs in outline order', () => {
    const conversation = makeConversation([
      makeGeneration('# T\n## The Drop\nOne.\n## The Drop!\nTwo.\n## The drop?\nThree.', 1)
    ])

    expect(buildScriptFs(conversation).sections.map(section => section.slug)).toEqual([
      'the-drop',
      'the-drop-2',
      'the-drop-3'
    ])
  })

  it('skips a suffix that a later title already claims naturally', () => {
    const conversation = makeConversation([
      makeGeneration('# T\n## Drift\nOne.\n## Drift 2\nTwo.\n## Drift!\nThree.', 1)
    ])

    expect(buildScriptFs(conversation).sections.map(section => section.slug)).toEqual([
      'drift',
      'drift-2',
      'drift-3'
    ])
  })

  it('falls back to a generic slug when a title has no alphanumerics', () => {
    const conversation = makeConversation([makeGeneration('# T\n## ***\nStars.', 1)])

    expect(buildScriptFs(conversation).sections[0].path).toBe('/sections/010-section')
  })

  it('marks a section stale when its description changes after the body was written', () => {
    const conversation = makeConversation([
      makeGeneration('# T\n## Alpha\nOriginal spec.', 1),
      makeGeneration('## Alpha\nAlpha body.', 2),
      makeGeneration('# T\n## Alpha\nRevised spec.', 3)
    ])

    const section = buildScriptFs(conversation).sections[0]

    expect(section.specifiedAt).toBe(3)
    expect(section.generatedAt).toBe(2)
    expect(section.stale).toBe(true)
    expect(section.prompt).toBe('Revised spec.')
  })

  it('is fresh again once the body is regenerated after the spec change', () => {
    const conversation = makeConversation([
      makeGeneration('# T\n## Alpha\nOriginal spec.', 1),
      makeGeneration('## Alpha\nAlpha body.', 2),
      makeGeneration('# T\n## Alpha\nRevised spec.', 3),
      makeGeneration('## Alpha\nRewritten body.', 4, { exampleIds: ['ex-1', 'ex-2'] })
    ])

    const section = buildScriptFs(conversation).sections[0]

    expect(section.stale).toBe(false)
    expect(section.generatedAt).toBe(4)
    expect(section.content).toBe('Rewritten body.')
    expect(section.exampleIds).toEqual(['ex-1', 'ex-2'])
  })

  it('dates the spec to the earliest outline it has held unchanged through', () => {
    const conversation = makeConversation([
      makeGeneration('# T\n## Alpha\nSpec.\n## Beta\nBeta spec.', 1),
      makeGeneration('# T\n## Alpha\nSpec.\n## Beta\nBeta revised.', 2),
      makeGeneration('# T\n## Alpha\nSpec.\n## Beta\nBeta revised.', 3)
    ])

    const [alpha, beta] = buildScriptFs(conversation).sections

    expect(alpha.specifiedAt).toBe(1)
    expect(beta.specifiedAt).toBe(2)
  })

  it('reports an ungenerated section as empty and stale', () => {
    const tree = buildScriptFs(makeConversation([makeGeneration(outlineV1, 1)]))
    const escalation = tree.sections[2]

    expect(escalation.content).toBe('')
    expect(escalation.wordCount).toBe(0)
    expect(escalation.stale).toBe(true)
    expect(escalation.generatedAt).toBeUndefined()
  })

  it('unmounts every written section when there is no outline at all', () => {
    const conversation = makeConversation([makeGeneration('## Alpha\nAlpha body.', 1)])
    const tree = buildScriptFs(conversation)

    expect(tree.title).toBe('')
    expect(tree.sections).toEqual([])
    expect(tree.unmounted).toEqual([{ title: 'Alpha', content: 'Alpha body.' }])
  })
})

describe('listScriptFsPaths', () => {
  it('lists the brief, the script and three files per mounted section, sorted', () => {
    const tree = buildScriptFs(makeConversation([
      makeGeneration('# T\n## Alpha\nAlpha spec.\n## Beta\nBeta spec.', 1)
    ]))

    expect(listScriptFsPaths(tree)).toEqual([
      '/brief.md',
      '/script.md',
      '/sections/010-alpha/content.md',
      '/sections/010-alpha/meta.yaml',
      '/sections/010-alpha/prompt.md',
      '/sections/020-beta/content.md',
      '/sections/020-beta/meta.yaml',
      '/sections/020-beta/prompt.md'
    ])
  })
})

describe('readScriptFsPath', () => {
  const conversation = makeConversation([
    makeGeneration('# The Quiet Descent\n## Induction\nSettle the listener.\n## Deepening\nTake them down.', 1, {
      messages: [{ role: 'user', content: 'A winter forest.' }]
    }),
    makeGeneration('## Induction\nBreathe out slowly.', 2)
  ])
  const tree = buildScriptFs(conversation)

  it('reads the brief', () => {
    expect(readScriptFsPath(tree, '/brief.md')).toBe('A winter forest.')
  })

  it('reads the consolidated script in outline order, skipping empty sections', () => {
    expect(readScriptFsPath(tree, '/script.md')).toBe('# The Quiet Descent\n\n## Induction\nBreathe out slowly.')
  })

  it('reads a section prompt and content', () => {
    expect(readScriptFsPath(tree, '/sections/010-induction/prompt.md')).toBe('Settle the listener.')
    expect(readScriptFsPath(tree, '/sections/010-induction/content.md')).toBe('Breathe out slowly.')
    expect(readScriptFsPath(tree, '/sections/020-deepening/content.md')).toBe('')
  })

  it('reads derived metadata as yaml', () => {
    expect(readScriptFsPath(tree, '/sections/010-induction/meta.yaml')).toBe(
      [
        'title: Induction',
        'slug: induction',
        'path: /sections/010-induction',
        'order: 10',
        'wordCount: 3',
        'stale: false',
        'generatedAt: 2',
        'specifiedAt: 1',
        ''
      ].join('\n')
    )
  })

  it('returns null for unknown paths', () => {
    expect(readScriptFsPath(tree, '/sections/090-nowhere/content.md')).toBeNull()
    expect(readScriptFsPath(tree, '/sections/010-induction/notes.md')).toBeNull()
    expect(readScriptFsPath(tree, '/nonsense')).toBeNull()
  })
})

describe('resolveSectionPath', () => {
  const tree = buildScriptFs(makeConversation([
    makeGeneration('# T\n## Induction\nSettle the listener.', 1)
  ]))

  it('accepts the directory, a trailing slash, or any file beneath it', () => {
    expect(resolveSectionPath(tree, '/sections/010-induction')?.title).toBe('Induction')
    expect(resolveSectionPath(tree, '/sections/010-induction/')?.title).toBe('Induction')
    expect(resolveSectionPath(tree, '/sections/010-induction/meta.yaml')?.title).toBe('Induction')
  })

  it('returns null for a path that is not a section', () => {
    expect(resolveSectionPath(tree, '/script.md')).toBeNull()
    expect(resolveSectionPath(tree, '/sections/010-inductio')).toBeNull()
  })
})

describe('renderScriptFsTree', () => {
  it('renders aligned word counts and statuses', () => {
    const conversation = makeConversation([
      makeGeneration(outlineV1, 1),
      makeGeneration(`## Induction\n${words(412)}`, 2),
      makeGeneration(`## Deepening\n${words(389)}`, 3),
      makeGeneration(outlineV1.replace('Take them down.', 'Take them much deeper.'), 4)
    ])

    expect(renderScriptFsTree(buildScriptFs(conversation))).toBe(
      [
        '# The Quiet Descent',
        '/sections/',
        '  010-induction/       412w  fresh',
        '  020-deepening/       389w  stale',
        '  030-escalation/        0w  empty',
        ''
      ].join('\n')
    )
  })

  it('names sections that are not in the outline', () => {
    const conversation = makeConversation([
      makeGeneration('# T\n## Alpha\nAlpha spec.', 1),
      makeGeneration('## Beta\nBeta body.\n## Gamma\nGamma body.', 2)
    ])

    const rendered = renderScriptFsTree(buildScriptFs(conversation))

    expect(rendered.endsWith('(2 sections not in the outline: "Beta", "Gamma")\n')).toBe(true)
  })
})
