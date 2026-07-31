import type { RawConversation } from '../types/conversation'

// The script page reads as a conversation: the brief the user gave, the
// instructions they added since, and what the model did in between. The
// stored conversation only keeps prompts and responses, so the turns are
// derived here — user instructions are recovered from the prompt templates
// that embedded them (see services/prompts.ts).

export type ThreadEntry =
  | { id: string; kind: 'user'; text: string; chips?: string[] }
  | { id: string; kind: 'activity'; label: string; detail?: string }

const REFINEMENT_INSTRUCTION =
  /The user wants to refine the script above\. Their instruction:\s*\n+([\s\S]*?)\n+Apply this instruction/

const REWRITE_INSTRUCTION =
  /Additional instruction from the user for this rewrite:\s*\n+([\s\S]*)$/

// A generation's user message carries the exemplars and the running script
// ahead of the instruction, so these match the instruction wherever it sits
const MANUAL_EDIT = /I have manually edited the "(.+?)" section/
const SECTION_REWRITE = /Now rewrite the "(.+?)" section/
const SECTION_WRITE = /Now write the "(.+?)" section/

const countWords = (text: string): number =>
  text.split(/\s+/).filter(word => word.length > 0).length

const sectionTitles = (response: string): string[] =>
  response
    .split('\n')
    .map(line => line.match(/^##\s+(.+?)\s*$/)?.[1])
    .filter((title): title is string => Boolean(title))

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

const lastUserMessage = (messages: { role: string; content: string }[]): string =>
  [...messages].reverse().find(message => message.role === 'user')?.content ?? ''

export interface ThreadInput {
  // The brief that started the script, shown as the opening user turn
  brief?: string
  // Short facts about the request (tags, requested length) shown beneath it
  chips?: string[]
  conversation?: RawConversation
  // While a generation streams, its half-written response is already shown by
  // the live status line and the document, so it is left out of the thread
  isStreaming?: boolean
}

export const buildThread = ({ brief, chips, conversation, isStreaming }: ThreadInput): ThreadEntry[] => {
  const entries: ThreadEntry[] = []

  if (brief?.trim()) {
    entries.push({ id: 'brief', kind: 'user', text: brief.trim(), chips })
  }

  const generations = conversation
    ? isStreaming
      ? conversation.generations.slice(0, -1)
      : conversation.generations
    : []

  generations.forEach((generation, index) => {
    const prompt = lastUserMessage(generation.messages)
    const response = generation.response
    const isOutline = /^#(?!#)/.test(response.trimStart())

    if (isOutline) {
      const planned = sectionTitles(response).length
      entries.push({
        id: `gen-${index}`,
        kind: 'activity',
        label: 'Planned the outline',
        detail: planned > 0 ? plural(planned, 'section') : undefined
      })
      return
    }

    const manualEdit = prompt.match(MANUAL_EDIT)
    if (manualEdit) {
      entries.push({
        id: `gen-${index}`,
        kind: 'activity',
        label: `Edited "${manualEdit[1]}" by hand`
      })
      return
    }

    const refinement = prompt.match(REFINEMENT_INSTRUCTION)
    if (refinement) {
      const revised = sectionTitles(response)
      entries.push({
        id: `gen-${index}-instruction`,
        kind: 'user',
        text: refinement[1].trim()
      })
      entries.push({
        id: `gen-${index}`,
        kind: 'activity',
        label: revised.length > 0
          ? `Revised ${revised.map(title => `"${title}"`).join(', ')}`
          : 'Revised the script'
      })
      return
    }

    const rewrite = prompt.match(SECTION_REWRITE)
    if (rewrite) {
      const instruction = prompt.match(REWRITE_INSTRUCTION)
      if (instruction) {
        entries.push({
          id: `gen-${index}-instruction`,
          kind: 'user',
          text: instruction[1].trim()
        })
      }
      entries.push({
        id: `gen-${index}`,
        kind: 'activity',
        label: `Rewrote "${rewrite[1]}"`,
        detail: plural(countWords(response), 'word')
      })
      return
    }

    const written = prompt.match(SECTION_WRITE)
    if (written) {
      entries.push({
        id: `gen-${index}`,
        kind: 'activity',
        label: `Wrote "${written[1]}"`,
        detail: plural(countWords(response), 'word')
      })
      return
    }

    // Anything else that rewrote sections — a review or critique pass
    const touched = sectionTitles(response)
    entries.push({
      id: `gen-${index}`,
      kind: 'activity',
      label: touched.length > 0
        ? `Updated ${touched.map(title => `"${title}"`).join(', ')}`
        : 'Updated the script'
    })
  })

  return entries
}
