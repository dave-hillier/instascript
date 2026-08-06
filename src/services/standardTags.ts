// A small standard vocabulary that sits alongside free-form tags (story 8.17).
//
// Topic tags — sleep, confidence, jealousy — describe what a script is about,
// and free text is right for those: the subject matter is open-ended. But a
// handful of properties are asked of nearly every script in a corpus like
// this one, and they are the properties that decide whether a script is the
// right one to open, to be grounded in, or to be read aloud tonight: how
// explicit it is, who it addresses, and whether it does anything that lasts
// past the session. Left to free text those arrive as "nsfw" on one script,
// "erotic" on the next and "explicit content" on a third, which neither
// search nor the eye can group.
//
// So they are facets with fixed values here. The vocabulary is deliberately
// short — a tag nobody can decide the value of is a tag nobody applies — and
// everything outside it stays free text.
//
// This module is pure and knows nothing about storage or React: the corpus
// canonicalises through it on the way in and out, the tagging prompt is built
// from it, and the corpus view offers it as pickers.

export interface StandardTagOption {
  tag: string
  label: string
  // What the tag means, shown as the control's tooltip and given to the
  // utility model so it picks the same way a person would
  help: string
}

export interface StandardTagFacet {
  id: string
  label: string
  // Whether a script can carry only one value of this facet (a script is one
  // level of explicit) or any number (it may install a trigger and a
  // post-hypnotic suggestion both)
  exclusive: boolean
  // How the model is told to treat the facet, and how the picker reads
  instruction: string
  options: StandardTagOption[]
}

export const STANDARD_TAG_FACETS: StandardTagFacet[] = [
  {
    id: 'explicitness',
    label: 'Explicitness',
    exclusive: true,
    instruction: 'exactly one',
    options: [
      {
        tag: 'non-explicit',
        label: 'Non-explicit',
        help: 'No sexual content — relaxation, therapeutic or recreational trance'
      },
      {
        tag: 'suggestive',
        label: 'Suggestive',
        help: 'Sensual or charged, but stops short of describing sex'
      },
      {
        tag: 'explicit',
        label: 'Explicit',
        help: 'Explicit sexual content'
      }
    ]
  },
  {
    id: 'subject',
    label: 'Written for',
    exclusive: true,
    instruction: 'exactly one',
    options: [
      {
        tag: 'female subject',
        label: 'A woman',
        help: 'Addresses a female listener — her body, her anatomy, feminine forms of address'
      },
      {
        tag: 'male subject',
        label: 'A man',
        help: 'Addresses a male listener — his body, his anatomy, masculine forms of address'
      },
      {
        tag: 'any subject',
        label: 'Anyone',
        help: 'Nothing in the script assumes the listener has a particular body or gender'
      }
    ]
  },
  {
    id: 'contains',
    label: 'Contains',
    exclusive: false,
    instruction: 'any that apply, none if none do',
    options: [
      {
        tag: 'triggers',
        label: 'Triggers',
        help: 'Installs or uses a trigger word, phrase or gesture'
      },
      {
        tag: 'post-hypnotic',
        label: 'Post-hypnotic',
        help: 'Carries suggestions meant to act after the session ends'
      },
      {
        tag: 'amnesia',
        label: 'Amnesia',
        help: 'Suggests forgetting part of the session or the suggestions themselves'
      },
      {
        tag: 'aftercare',
        label: 'Aftercare',
        help: 'Ends with grounding, reassurance or a settling passage after emergence'
      }
    ]
  }
]

// Every standard tag, in facet order, which is the order they are shown and
// written in
export const STANDARD_TAGS: string[] = STANDARD_TAG_FACETS.flatMap(facet =>
  facet.options.map(option => option.tag)
)

const FACET_BY_TAG = new Map<string, StandardTagFacet>(
  STANDARD_TAG_FACETS.flatMap(facet =>
    facet.options.map(option => [option.tag, facet] as const)
  )
)

// The ways the same property gets written — by a user typing quickly, by a
// small model asked for tags, and by material imported from elsewhere. Every
// key here collapses onto a standard tag, so a corpus tagged before this
// vocabulary existed converges on it rather than needing a migration.
const SYNONYMS: Record<string, string> = {
  // Explicitness
  nsfw: 'explicit',
  erotic: 'explicit',
  sexual: 'explicit',
  'sexually explicit': 'explicit',
  'explicit content': 'explicit',
  'adult content': 'explicit',
  sensual: 'suggestive',
  suggestive: 'suggestive',
  teasing: 'suggestive',
  'mildly erotic': 'suggestive',
  sfw: 'non-explicit',
  clean: 'non-explicit',
  'non explicit': 'non-explicit',
  nonexplicit: 'non-explicit',
  'non sexual': 'non-explicit',
  'non-sexual': 'non-explicit',

  // Subject
  female: 'female subject',
  woman: 'female subject',
  'for women': 'female subject',
  'for her': 'female subject',
  'female listener': 'female subject',
  'female audience': 'female subject',
  male: 'male subject',
  man: 'male subject',
  'for men': 'male subject',
  'for him': 'male subject',
  'male listener': 'male subject',
  'male audience': 'male subject',
  'any gender': 'any subject',
  'all genders': 'any subject',
  'gender neutral': 'any subject',
  'gender-neutral': 'any subject',
  'any listener': 'any subject',

  // Contains
  trigger: 'triggers',
  'trigger word': 'triggers',
  'trigger words': 'triggers',
  'trigger phrase': 'triggers',
  'trigger installation': 'triggers',
  'post hypnotic': 'post-hypnotic',
  posthypnotic: 'post-hypnotic',
  'post hypnotic suggestion': 'post-hypnotic',
  'post-hypnotic suggestion': 'post-hypnotic',
  'post hypnotic suggestions': 'post-hypnotic',
  'post-hypnotic suggestions': 'post-hypnotic',
  'hypnotic amnesia': 'amnesia',
  'suggested amnesia': 'amnesia',
  'after care': 'aftercare'
}

export function isStandardTag(tag: string): boolean {
  return FACET_BY_TAG.has(tag)
}

export function facetForTag(tag: string): StandardTagFacet | undefined {
  return FACET_BY_TAG.get(tag)
}

// Pure: one tag in the form the corpus stores. A standard tag or one of its
// known spellings becomes the standard tag; anything else is left as the user
// wrote it, tidied only for case and spacing.
export function canonicalTag(tag: string): string {
  const tidied = tag.trim().toLowerCase().replace(/\s+/g, ' ')
  return SYNONYMS[tidied] ?? tidied
}

// Pure: a whole tag list in the form the corpus stores — canonicalised,
// deduplicated, standard tags first in facet order, and at most one value of
// each exclusive facet. A script tagged both "explicit" and "suggestive" is a
// script whose tags disagree; the first one wins rather than both being kept
// and neither being trusted.
export function canonicalizeTags(tags: string[]): string[] {
  const standard: string[] = []
  const custom: string[] = []
  const seen = new Set<string>()
  const claimedFacets = new Set<string>()

  for (const raw of tags) {
    const tag = canonicalTag(raw)
    if (!tag || seen.has(tag)) continue

    const facet = FACET_BY_TAG.get(tag)
    if (facet) {
      if (facet.exclusive && claimedFacets.has(facet.id)) continue
      if (facet.exclusive) claimedFacets.add(facet.id)
      standard.push(tag)
    } else {
      custom.push(tag)
    }
    seen.add(tag)
  }

  standard.sort((a, b) => STANDARD_TAGS.indexOf(a) - STANDARD_TAGS.indexOf(b))
  return [...standard, ...custom]
}

// The standard tags a list carries, in facet order
export function standardTagsIn(tags: string[]): string[] {
  return canonicalizeTags(tags).filter(isStandardTag)
}

// Everything else, in the order it was written
export function customTagsIn(tags: string[]): string[] {
  return canonicalizeTags(tags).filter(tag => !isStandardTag(tag))
}

// The vocabulary as the tagging prompt states it: one line per facet, each
// value with the sentence that decides it
export function describeStandardTagVocabulary(): string {
  return STANDARD_TAG_FACETS.map(facet => {
    const options = facet.options
      .map(option => `${option.tag} (${option.help})`)
      .join('; ')
    return `- ${facet.label} — ${facet.instruction}: ${options}`
  }).join('\n')
}
