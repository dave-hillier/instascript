import type OpenAI from 'openai'
import { SECTION_TARGET_WORDS, SECTION_MIN_WORDS, SECTION_MAX_WORDS } from './sectionQuality'

// The four tools the model writes a script with: it grounds itself in the
// corpus, writes the plan, then writes one section per call and revises the
// ones the review objects to. The script is assembled from the accepted calls
// rather than parsed back out of prose, so a section that comes back the wrong
// length is rejected at the call rather than patched up afterwards.
//
// This module is declaration only: the schemas and the wording the model reads
// live here, and the callers that hand them to a provider and run the calls
// live elsewhere.

// The installed openai package (5.15) splits its tool union into a function
// arm and a custom arm; the function arm is exactly the shape we emit, so we
// reuse it rather than restating it and risking drift from the wire format.
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionFunctionTool

export const GROUNDING_SELECT_TOOL = 'grounding_select'
export const OUTLINE_WRITE_TOOL = 'outline_write'
export const SECTION_WRITE_TOOL = 'section_write'
export const SECTION_REVISE_TOOL = 'section_revise'

export type WritingToolName =
  | typeof GROUNDING_SELECT_TOOL
  | typeof OUTLINE_WRITE_TOOL
  | typeof SECTION_WRITE_TOOL
  | typeof SECTION_REVISE_TOOL

// The word window is stated to the model in the same numbers sectionQuality
// enforces, built from those constants so the prose and the check can never
// say different things.
const SECTION_LENGTH_RULE =
  `Aim the body at about ${SECTION_TARGET_WORDS} words. A body under ` +
  `${SECTION_MIN_WORDS} or over ${SECTION_MAX_WORDS} words is rejected with its measured count, ` +
  'and must be rewritten at the stated length rather than argued with. That window is wider ' +
  'above the target than below it on purpose: a section that runs long can be cut, while one ' +
  'that runs short leaves the sections after it carrying what it skipped — so where you cannot ' +
  'land on the target, go over rather than under.'

export const GROUNDING_SELECT: ToolSpec = {
  type: 'function',
  function: {
    name: GROUNDING_SELECT_TOOL,
    description:
      'Select the corpus examples that ground this script. Call this once, before writing ' +
      'anything else, passing the brief as the query. The ranking is done here, not by you: what ' +
      'comes back is the style material the outline and every section are then written against.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'The brief, verbatim, plus any style direction the user gave.'
        }
      },
      required: ['query']
    }
  }
}

export const OUTLINE_WRITE: ToolSpec = {
  type: 'function',
  function: {
    name: OUTLINE_WRITE_TOOL,
    description:
      'Write the whole plan for the script: its title and every section in reading order, each ' +
      'with what it must cover and the words it should run to. Call this once, after grounding ' +
      'and before any section. Writing the outline again replaces it whole, so send the entire ' +
      'plan every time rather than the part that changed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'The script\'s title.'
        },
        sections: {
          type: 'array',
          description: 'Every section in reading order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: {
                type: 'string',
                description: 'Section heading; unique within the outline, and the exact title the section is later written under.'
              },
              description: {
                type: 'string',
                description: 'What this section must cover.'
              },
              target_words: {
                type: 'integer',
                description: `Words this section should run to; around ${SECTION_TARGET_WORDS}.`
              }
            },
            required: ['title', 'description', 'target_words']
          }
        }
      },
      required: ['title', 'sections']
    }
  }
}

export const SECTION_WRITE: ToolSpec = {
  type: 'function',
  function: {
    name: SECTION_WRITE_TOOL,
    description:
      'Write one whole planned section under its exact outline title. The body is prose only, ' +
      'with no heading line — the heading comes from the outline title. Call this once per ' +
      'planned section, in outline order; a section already written is replaced with ' +
      `${SECTION_REVISE_TOOL}, never written again. ${SECTION_LENGTH_RULE}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Exact outline title of the section being written.'
        },
        body: {
          type: 'string',
          description: 'The whole section, prose only, with no heading line.'
        }
      },
      required: ['title', 'body']
    }
  }
}

export const SECTION_REVISE: ToolSpec = {
  type: 'function',
  function: {
    name: SECTION_REVISE_TOOL,
    description:
      'Replace one already-written section with a corrected whole body, naming the reason it is ' +
      'being rewritten. Use this for a review finding, a rejected length, or a refinement the ' +
      'user asked for; never for a section that has not been written yet. The replacement is the ' +
      'whole section, prose only and with no heading line, and it is held to the same window: ' +
      SECTION_LENGTH_RULE,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Exact outline title of the already-written section.'
        },
        body: {
          type: 'string',
          description: 'The whole replacement section, prose only, with no heading line.'
        },
        reason: {
          type: 'string',
          description: 'Why this section is being replaced.'
        }
      },
      required: ['title', 'body', 'reason']
    }
  }
}

// Pipeline order: grounding, then the plan, then the writing and the rewriting.
// The model reads the list in the order it is given them, so the order is the
// first hint about the order they are meant to be called in.
// Offered whole on every request, never as a subset. Tools have to be
// identical between requests for a prompt-cache hit, and the cache key is
// hashed from the system message alone — so a varying tool list would silently
// cost the cache while the key claimed otherwise. A tool that must not be
// called twice is refused by its handler, not withdrawn from the list.
export const WRITING_TOOLS: readonly ToolSpec[] = [
  GROUNDING_SELECT,
  OUTLINE_WRITE,
  SECTION_WRITE,
  SECTION_REVISE
]

