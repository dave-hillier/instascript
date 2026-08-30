import { describe, it, expect } from 'vitest'
import {
  WRITING_TOOLS,
  GROUNDING_SELECT,
  OUTLINE_WRITE,
  SECTION_WRITE,
  SECTION_REVISE,
  GROUNDING_SELECT_TOOL,
  OUTLINE_WRITE_TOOL,
  SECTION_WRITE_TOOL,
  SECTION_REVISE_TOOL
} from '../writingTools'
import type { ToolSpec } from '../writingTools'
import { SECTION_TARGET_WORDS, SECTION_MIN_WORDS, SECTION_MAX_WORDS } from '../sectionQuality'

// The wire type leaves `parameters` as an open record, so the tests read it
// back through the JSON Schema shape we actually emit.
interface JsonSchema {
  type: string
  additionalProperties?: boolean
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  description?: string
}

const schemaOf = (tool: ToolSpec): JsonSchema => tool.function.parameters as unknown as JsonSchema

// Every tool is an object schema that names its properties, requires exactly
// the arguments it can use, and refuses anything else — a stray argument is a
// misunderstanding worth surfacing as an error rather than dropping silently.
const expectClosedObjectSchema = (schema: JsonSchema, required: string[]): void => {
  expect(schema.type).toBe('object')
  expect(schema.additionalProperties).toBe(false)
  expect(schema.required).toEqual(required)
  expect(Object.keys(schema.properties ?? {})).toEqual(required)
  for (const property of Object.values(schema.properties ?? {})) {
    expect(property.description).toBeTruthy()
  }
}

describe('the writing tools', () => {
  it('offers the four tools in pipeline order', () => {
    expect(WRITING_TOOLS.map(tool => tool.function.name)).toEqual([
      GROUNDING_SELECT_TOOL,
      OUTLINE_WRITE_TOOL,
      SECTION_WRITE_TOOL,
      SECTION_REVISE_TOOL
    ])
  })

  it('declares every tool as a function tool with a description', () => {
    for (const tool of WRITING_TOOLS) {
      expect(tool.type).toBe('function')
      expect(tool.function.description).toBeTruthy()
    }
  })
})

describe('grounding_select', () => {
  it('takes the ranking query', () => {
    expect(GROUNDING_SELECT.function.name).toBe('grounding_select')
    expectClosedObjectSchema(schemaOf(GROUNDING_SELECT), ['query'])
    expect(schemaOf(GROUNDING_SELECT).properties?.query.type).toBe('string')
  })
})

describe('outline_write', () => {
  it('takes the title and the whole ordered section list', () => {
    expect(OUTLINE_WRITE.function.name).toBe('outline_write')
    expectClosedObjectSchema(schemaOf(OUTLINE_WRITE), ['title', 'sections'])
    expect(schemaOf(OUTLINE_WRITE).properties?.sections.type).toBe('array')
  })

  it('closes the section item schema too', () => {
    const item = schemaOf(OUTLINE_WRITE).properties?.sections.items
    expect(item).toBeDefined()
    expectClosedObjectSchema(item as JsonSchema, ['title', 'description', 'target_words'])
    expect(item?.properties?.target_words.type).toBe('integer')
  })

  it('says the plan is written once and replaced whole', () => {
    expect(OUTLINE_WRITE.function.description).toMatch(/once/)
    expect(OUTLINE_WRITE.function.description).toMatch(/replaces it whole/)
  })
})

describe('section_write', () => {
  it('takes the outline title and the body', () => {
    expect(SECTION_WRITE.function.name).toBe('section_write')
    expectClosedObjectSchema(schemaOf(SECTION_WRITE), ['title', 'body'])
  })

  it('asks for prose with no heading line, since the heading is the outline title', () => {
    expect(SECTION_WRITE.function.description).toMatch(/prose only/)
    expect(SECTION_WRITE.function.description).toMatch(/no heading line/)
    expect(SECTION_WRITE.function.description).toMatch(/outline title/)
  })

  // The window in the prose the model reads and the window sectionQuality
  // rejects on are the same numbers; this is the test that keeps them so.
  it('states the same word window sectionQuality enforces', () => {
    const description = SECTION_WRITE.function.description ?? ''
    expect(description).toContain(String(SECTION_TARGET_WORDS))
    expect(description).toContain(String(SECTION_MIN_WORDS))
    expect(description).toContain(String(SECTION_MAX_WORDS))
  })

  it('explains why the window is lopsided, and which way to miss', () => {
    const description = SECTION_WRITE.function.description ?? ''
    expect(description).toMatch(/wider\s+above the target than below/)
    expect(description).toMatch(/over rather than under/)
  })

  it('sends an already-written section to the revise tool', () => {
    expect(SECTION_WRITE.function.description).toContain(SECTION_REVISE_TOOL)
  })
})

describe('section_revise', () => {
  it('takes the title, the replacement body and the reason', () => {
    expect(SECTION_REVISE.function.name).toBe('section_revise')
    expectClosedObjectSchema(schemaOf(SECTION_REVISE), ['title', 'body', 'reason'])
  })

  it('holds the replacement to the same word window', () => {
    const description = SECTION_REVISE.function.description ?? ''
    expect(description).toContain(String(SECTION_MIN_WORDS))
    expect(description).toContain(String(SECTION_MAX_WORDS))
  })

  it('is only for a section that already exists', () => {
    expect(SECTION_REVISE.function.description).toMatch(/never for a section that has not been written/)
  })
})
