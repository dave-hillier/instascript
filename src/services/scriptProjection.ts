import { countWords, extractDocumentTitle } from '../utils/scriptMetrics'
import { isOutlineResponse, isRejectedGeneration } from './conversationDocument'
import type {
  Generation,
  GenerationToolCall,
  GenerationToolCallStatus,
  RawConversation
} from '../types/conversation'

// Where a conversation becomes the document a reader sees: the reading view
// and the markdown export both fold here, so a conversation whose generations
// were authored by tool calls and one whose generations are plain markdown
// project identically.
//
// It is not the only fold. conversationDocument's consolidateSections builds
// the section text the prompts, the review pass and the filesystem export work
// from, and it reads markdown alone — it has no need of a call's verdict,
// because the body is stored in the response either way. The two agree on the
// one thing they must: both skip a wholly rejected generation, through the
// isRejectedGeneration re-exported below.
//
// The dispatch is per generation, not per conversation: a script begun before
// tool-call authoring and continued after it interleaves both kinds, and both
// must fold. A generation carrying tool calls is folded from them; anything
// else is parsed out of its markdown response exactly as it always was.
//
// Pure over its inputs — no React, no window — so it can be read and tested
// without dragging the page's browser-only dependencies in.

export interface ProjectedSection {
  // Stable slug the reading view wires into aria-controls
  id: string
  title: string
  content: string
  wordCount: number
  // The verdict the writing tool call reached on this body, carried out of the
  // fold so the reading view can say so. Absent for a plainly accepted section
  // and for one parsed out of markdown, so the ordinary case projects exactly
  // as it always did; present when the section was kept despite failing the
  // length window, which must never read as a clean acceptance (D5).
  status?: GenerationToolCallStatus
  // The waiver's justification, as the tool handler worded it
  statusReason?: string
}

export interface ProjectedDocument {
  title?: string
  sections: ProjectedSection[]
  fullContent: string
}

// The generation currently streaming, if any. The projection splices its
// partial text over the stored section so the reader watches the rewrite land.
export interface LiveGeneration {
  conversationId: string
  isComplete: boolean
  sectionTitle?: string
}

// A generation every one of whose calls was rejected contributed nothing to
// the script: its body was sent back to be rewritten. Every reader that folds
// a conversation — this projection, the consolidation the prompts and the
// review pass fold with, the history a follow-up request replays, the activity
// thread, a resumed run — has to agree on that, so the test is defined once in
// conversationDocument (which both folds already import) and re-exported here
// for the readers that reach it through this module.
export { isRejectedGeneration }

// The note a projected section carries into the reading view, or null when it
// has nothing to say. D5's waiver has to stay visible, and the only place a
// reader looks is the section itself, so the decision of whether a note is due
// and how it reads is made here — a pure function the tests can hold — rather
// than inside JSX no test in this environment can render.
export const sectionStatusNote = (
  section: Pick<ProjectedSection, 'status' | 'statusReason' | 'wordCount'>
): string | null => {
  if (section.status !== 'waived') return null
  // The handler's own wording when it gave one; otherwise the measurement the
  // waiver was granted over, so the note is never bare.
  return section.statusReason
    ? `Kept outside the length window: ${section.statusReason}`
    : `Kept outside the length window at ${section.wordCount} words`
}

export const sectionSlug = (title: string): string =>
  `section_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`

// Split a markdown response into its "## Section" bodies. The document title is
// only recognised on the very first line: anything else with a leading "# " is
// prose that happens to start with a hash, not a heading we own.
export const parseSections = (
  scriptContent: string
): { title?: string; sections: ProjectedSection[] } => {
  const lines = scriptContent.split('\n')
  const firstLine = lines[0]
  const titleMatch = firstLine.match(/^#\s+(.+)$/)
  const documentTitle = titleMatch ? titleMatch[1].trim() : undefined

  const sections: ProjectedSection[] = []
  let currentSectionStart = -1
  let currentSectionTitle = ''

  const push = (endLine: number) => {
    if (currentSectionStart < 0 || !currentSectionTitle) return
    const content = lines.slice(currentSectionStart + 1, endLine).join('\n').trim()
    sections.push({
      id: sectionSlug(currentSectionTitle),
      title: currentSectionTitle,
      content,
      wordCount: countWords(content)
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.match(/^##\s+/)) continue

    push(i)
    currentSectionStart = i
    // A heading with nothing printable after the hashes still opens a
    // section: dropping it would strand every line beneath it, silently
    // removing stored prose from the reading view and from exports.
    const heading = line.match(/##\s+(.+?)$/)?.[1]
    currentSectionTitle = heading?.trim() || heading || ''
  }

  push(lines.length)

  return { title: documentTitle, sections }
}

// A section replaces any earlier one with the same title: that is how a
// regeneration, a manual edit and a revise tool call all take effect.
const upsert = (sections: ProjectedSection[], section: ProjectedSection): void => {
  const existing = sections.findIndex(s => s.title === section.title)
  if (existing >= 0) {
    sections[existing] = section
  } else {
    sections.push(section)
  }
}

// --- the tool-call branch ------------------------------------------------
//
// Tool calls deliberately do NOT persist the section body: the rendered
// markdown in `generation.response` remains the sole storage of prose, so a
// folded call still reads its text out of the response it produced. The call
// supplies the identity (which section) and the verdict (kept or not).

const readToolCalls = (generation: Generation): GenerationToolCall[] | undefined =>
  generation.toolCalls && generation.toolCalls.length > 0 ? generation.toolCalls : undefined

const SECTION_TOOLS = new Set(['section_write', 'section_revise'])

// The body a section call wrote. Matched out of the rendered response by title;
// a response that is a bare body with no heading (or a single unmatched one) is
// taken whole, which is what a lone section_write renders as. The matched
// section is reported back so the caller knows which parsed heading the call
// spoke for and which are prose it did not name.
const bodyForCall = (
  call: GenerationToolCall,
  parsed: ProjectedSection[],
  response: string
): { content: string; wordCount: number; matched?: ProjectedSection } => {
  const matched = parsed.find(section => section.title === call.title)
    ?? (parsed.length === 1 ? parsed[0] : undefined)
  const content = matched ? matched.content : response.trim()
  // The recorded wordCount is the count the length window was judged against,
  // and the number a length waiver refers to, so it wins over a re-measure.
  return { content, wordCount: call.wordCount ?? countWords(content), matched }
}

const foldToolCalls = (
  generation: Generation,
  calls: GenerationToolCall[],
  sections: ProjectedSection[]
): string | undefined => {
  const parsed = parseSections(generation.response).sections
  // Every heading some call spoke for, so the sweep below can tell prose the
  // calls left unclaimed from prose a call already folded or refused.
  const claimed = new Set<string>()
  let foldedSection = false
  let title: string | undefined

  for (const call of calls) {
    if (call.name === 'outline_write') {
      // An outline's "## " bodies are the plan's descriptions, not script
      // prose, so they are claimed and never folded as sections.
      parsed.forEach(section => claimed.add(section.title))
      if (call.status !== 'rejected') {
        title = call.title ?? extractDocumentTitle(generation.response) ?? title
      }
      continue
    }

    if (!SECTION_TOOLS.has(call.name) || !call.title) continue

    const { content, wordCount, matched } = bodyForCall(call, parsed, generation.response)
    claimed.add(call.title)
    if (matched) claimed.add(matched.title)

    // A rejected attempt was never part of the script — its body was sent back
    // to be rewritten. A waived one was accepted, out-of-window and all, so it
    // folds like any other, carrying the waiver with it.
    if (call.status === 'rejected') continue

    foldedSection = true
    upsert(sections, {
      id: sectionSlug(call.title),
      title: call.title,
      content,
      wordCount,
      ...(call.status === 'accepted' ? {} : { status: call.status, statusReason: call.reason })
    })
  }

  // A tool-written body can render as more than the one section its call
  // names — a section_revise that returns two headings, say. The rendered
  // response is the sole storage of prose (see above), so anything stored and
  // unclaimed is folded too; dropping it would make text vanish from the
  // reading view and the export while still sitting in the conversation.
  if (foldedSection) {
    for (const section of parsed) {
      if (claimed.has(section.title)) continue
      upsert(sections, section)
    }
  }

  return title
}

// --- the legacy markdown branch -----------------------------------------

const foldMarkdown = (
  generation: Generation,
  sections: ProjectedSection[]
): string | undefined => {
  if (isOutlineResponse(generation.response)) {
    return extractDocumentTitle(generation.response) ?? undefined
  }

  for (const section of parseSections(generation.response).sections) {
    upsert(sections, section)
  }
  return undefined
}

// --- the projection ------------------------------------------------------

export function projectConversation(
  conversation: RawConversation | undefined,
  currentGeneration?: LiveGeneration | null
): ProjectedDocument {
  const sections: ProjectedSection[] = []
  let title: string | undefined

  for (const generation of conversation?.generations ?? []) {
    const calls = readToolCalls(generation)
    const foldedTitle = calls
      ? foldToolCalls(generation, calls, sections)
      : foldMarkdown(generation, sections)
    // A retried conversation can hold a fresh outline after earlier sections,
    // so the last title to arrive wins.
    title = foldedTitle ?? title
  }

  const live = conversation && currentGeneration &&
    currentGeneration.conversationId === conversation.id &&
    !currentGeneration.isComplete &&
    currentGeneration.sectionTitle
    ? currentGeneration.sectionTitle
    : undefined

  if (conversation && live) spliceLiveSection(conversation, sections, live)

  const fullContent = [
    title ? `# ${title}` : '',
    ...sections.map(section => `## ${section.title}\n${section.content}`)
  ].filter(Boolean).join('\n\n')

  return { title, sections, fullContent }
}

// The in-flight section, spliced over the stored one or appended if it is new.
// Deliberately reads the LAST generation whatever it holds and takes only its
// first parsed section: while a response is still streaming that is the section
// being written, and until its "## Title" line arrives there is nothing to show
// — so the stored text stays put rather than blanking.
const spliceLiveSection = (
  conversation: RawConversation,
  sections: ProjectedSection[],
  sectionTitle: string
): void => {
  const lastGeneration = conversation.generations[conversation.generations.length - 1]
  const liveSections = parseSections(lastGeneration?.response || '').sections
  if (liveSections.length === 0) return
  const live = liveSections[0]

  const existing = sections.findIndex(section => section.title === sectionTitle)
  if (existing >= 0) {
    sections[existing] = { ...sections[existing], content: live.content, wordCount: live.wordCount }
  } else {
    sections.push(live)
  }
}
