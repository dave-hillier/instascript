import { describe, it, expect } from 'vitest'
import {
  advanceImportFile,
  createImportProgress,
  describeImportOutcome,
  describeImportProgress,
  describeImportStage,
  importStageFraction,
  isImportStageTerminal,
  summarizeImportProgress,
  type ImportFileProgress
} from '../importProgress'

const progress = (...stages: ImportFileProgress['stage'][]): ImportFileProgress[] =>
  createImportProgress(stages.map((_, index) => `folder/file${index}.md`)).map(
    (file, index) => ({ ...file, stage: stages[index] })
  )

describe('createImportProgress', () => {
  it('queues every selected file under its own name', () => {
    const files = createImportProgress(['deep rest.md', 'folder/sub/focus.txt'])

    expect(files.map(file => file.name)).toEqual(['deep rest.md', 'focus.txt'])
    expect(files.map(file => file.path)).toEqual(['deep rest.md', 'folder/sub/focus.txt'])
    expect(files.every(file => file.stage === 'queued')).toBe(true)
  })

  it('keeps rows distinct when two folders hold the same file name', () => {
    const files = createImportProgress(['a/script.md', 'b/script.md'])

    expect(files[0].id).not.toBe(files[1].id)
  })
})

describe('advanceImportFile', () => {
  it('moves one file on and leaves the rest untouched', () => {
    const files = createImportProgress(['one.md', 'two.md'])

    const advanced = advanceImportFile(files, files[1].id, 'reading')

    expect(advanced[1].stage).toBe('reading')
    expect(advanced[0]).toBe(files[0])
  })

  it('records why a file was skipped', () => {
    const files = createImportProgress(['notes.pdf'])

    const advanced = advanceImportFile(files, files[0].id, 'skipped', {
      note: 'Not a markdown or text file'
    })

    expect(advanced[0]).toMatchObject({ stage: 'skipped', note: 'Not a markdown or text file' })
  })

  it('keeps the example id a later stage was told about', () => {
    const files = createImportProgress(['one.md'])

    const saved = advanceImportFile(files, files[0].id, 'saved', { exampleId: 'example_1' })
    const tagging = advanceImportFile(saved, files[0].id, 'tagging')

    expect(tagging[0].exampleId).toBe('example_1')
  })

  it('ignores an id that is not in the list', () => {
    const files = createImportProgress(['one.md'])

    expect(advanceImportFile(files, 'missing', 'done')).toEqual(files)
  })
})

describe('import stages', () => {
  it('runs from nothing done to fully done, never going backwards', () => {
    const fractions = (['queued', 'reading', 'saved', 'formatting', 'tagging', 'done'] as const).map(
      importStageFraction
    )

    expect(fractions[0]).toBe(0)
    expect(fractions[fractions.length - 1]).toBe(1)
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions)
  })

  it('draws a settled file as a full bar whether or not it was imported', () => {
    expect(importStageFraction('skipped')).toBe(1)
    expect(importStageFraction('failed')).toBe(1)
  })

  it('names the utility model jobs a file can be waiting on', () => {
    expect(describeImportStage('formatting')).toBe('Formatting as markdown')
    expect(describeImportStage('tagging')).toBe('Suggesting tags')
  })

  it('treats only the settled stages as terminal', () => {
    expect(isImportStageTerminal('done')).toBe(true)
    expect(isImportStageTerminal('skipped')).toBe(true)
    expect(isImportStageTerminal('failed')).toBe(true)
    expect(isImportStageTerminal('saved')).toBe(false)
  })
})

describe('summarizeImportProgress', () => {
  it('counts only the files that have settled', () => {
    const summary = summarizeImportProgress(progress('done', 'skipped', 'failed', 'tagging'))

    expect(summary).toEqual({
      total: 4,
      settled: 3,
      imported: 1,
      skipped: 1,
      failed: 1,
      finished: false
    })
  })

  it('is finished once nothing is still moving', () => {
    expect(summarizeImportProgress(progress('done', 'skipped')).finished).toBe(true)
  })

  it('is not finished before an import has started', () => {
    expect(summarizeImportProgress([]).finished).toBe(false)
  })

  it('does not count a saved file until the tidy pass has released it', () => {
    expect(summarizeImportProgress(progress('saved')).imported).toBe(0)
  })
})

describe('describeImportProgress', () => {
  it('reads as files processed out of files selected', () => {
    expect(describeImportProgress(summarizeImportProgress(progress('done', 'reading')))).toBe(
      '1 of 2 files'
    )
  })

  it('says file rather than files for a single import', () => {
    expect(describeImportProgress(summarizeImportProgress(progress('done')))).toBe('1 of 1 file')
  })
})

describe('describeImportOutcome', () => {
  it('reports what landed on its own when nothing was passed over', () => {
    expect(describeImportOutcome(summarizeImportProgress(progress('done', 'done')))).toBe(
      'Imported 2 examples.'
    )
  })

  it('says plainly what was skipped and what could not be read', () => {
    expect(
      describeImportOutcome(summarizeImportProgress(progress('done', 'skipped', 'failed')))
    ).toBe('Imported 1 example, skipped 1 unsupported or empty file, 1 could not be read.')
  })
})
