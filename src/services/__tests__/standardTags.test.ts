import { describe, it, expect } from 'vitest'
import {
  STANDARD_TAGS,
  STANDARD_TAG_FACETS,
  canonicalTag,
  canonicalizeTags,
  customTagsIn,
  describeStandardTagVocabulary,
  facetForTag,
  isStandardTag,
  standardTagsIn
} from '../standardTags'

describe('the standard vocabulary', () => {
  it('has a facet for explicitness, audience and content, each with values', () => {
    expect(STANDARD_TAG_FACETS.map(facet => facet.id)).toEqual([
      'explicitness',
      'subject',
      'contains'
    ])
    for (const facet of STANDARD_TAG_FACETS) {
      expect(facet.options.length).toBeGreaterThan(1)
    }
  })

  it('uses each tag in exactly one facet', () => {
    expect(new Set(STANDARD_TAGS).size).toBe(STANDARD_TAGS.length)
  })

  it('knows which facet a tag belongs to, and which tags are not standard', () => {
    expect(facetForTag('explicit')?.id).toBe('explicitness')
    expect(facetForTag('female subject')?.id).toBe('subject')
    expect(isStandardTag('triggers')).toBe(true)
    expect(isStandardTag('sleep')).toBe(false)
    expect(facetForTag('sleep')).toBeUndefined()
  })
})

describe('canonicalTag', () => {
  it('tidies case and spacing', () => {
    expect(canonicalTag('  Deep   Relaxation ')).toBe('deep relaxation')
  })

  it('collapses the other ways a standard tag gets written', () => {
    expect(canonicalTag('NSFW')).toBe('explicit')
    expect(canonicalTag('erotic')).toBe('explicit')
    expect(canonicalTag('for her')).toBe('female subject')
    expect(canonicalTag('male listener')).toBe('male subject')
    expect(canonicalTag('gender neutral')).toBe('any subject')
    expect(canonicalTag('post hypnotic suggestion')).toBe('post-hypnotic')
    expect(canonicalTag('trigger words')).toBe('triggers')
  })

  it('leaves a topic tag as the user wrote it', () => {
    expect(canonicalTag('jealousy')).toBe('jealousy')
  })
})

describe('canonicalizeTags', () => {
  it('puts the standard tags first, in facet order, keeping topics behind them', () => {
    expect(canonicalizeTags(['sleep', 'triggers', 'female subject', 'explicit'])).toEqual([
      'explicit',
      'female subject',
      'triggers',
      'sleep'
    ])
  })

  it('drops duplicates, including ones only equal after canonicalisation', () => {
    expect(canonicalizeTags(['nsfw', 'explicit', 'sleep', 'Sleep'])).toEqual([
      'explicit',
      'sleep'
    ])
  })

  it('keeps only the first value of a facet that holds one', () => {
    expect(canonicalizeTags(['suggestive', 'explicit', 'male subject', 'any subject'])).toEqual([
      'suggestive',
      'male subject'
    ])
  })

  it('keeps every value of a facet that holds several', () => {
    expect(canonicalizeTags(['amnesia', 'triggers', 'post-hypnotic'])).toEqual([
      'triggers',
      'post-hypnotic',
      'amnesia'
    ])
  })

  it('ignores blanks', () => {
    expect(canonicalizeTags(['', '  ', 'sleep'])).toEqual(['sleep'])
  })
})

describe('splitting a tag list', () => {
  const tags = ['sleep', 'explicit', 'female subject', 'deep relaxation']

  it('reads the standard tags out in facet order', () => {
    expect(standardTagsIn(tags)).toEqual(['explicit', 'female subject'])
  })

  it('reads the topic tags out in the order they were written', () => {
    expect(customTagsIn(tags)).toEqual(['sleep', 'deep relaxation'])
  })
})

describe('describeStandardTagVocabulary', () => {
  it('states every tag with what decides it, one line per facet', () => {
    const description = describeStandardTagVocabulary()
    expect(description.split('\n')).toHaveLength(STANDARD_TAG_FACETS.length)
    for (const tag of STANDARD_TAGS) {
      expect(description).toContain(tag)
    }
    expect(description).toContain('exactly one')
  })
})
