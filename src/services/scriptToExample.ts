// Saving a library script into the corpus (story 8.16) — the other direction
// of the same round trip as exampleToScript. A script's text lives in its
// conversation, so what can be saved, and what it would say, is derived here
// rather than read off the script record.

import type { Script } from '../types/script'
import type { RawConversation } from '../types/conversation'
import type { ExampleRecord } from '../types/example'
import { buildConsolidatedMarkdown } from '../utils/scriptExport'
import { countWords } from '../utils/scriptMetrics'
import { getScriptTimestamp } from '../utils/scriptLibrary'

export interface PromotableScript {
  script: Script
  // The consolidated markdown as the script stands now, including
  // regenerations and manual edits
  content: string
  wordCount: number
  // The example already held for this script, when the corpus has one. A
  // second save updates that example rather than adding a duplicate.
  savedExampleId?: string
  savedFolder?: string
}

// Pure: the scripts worth offering as examples, newest first. A script with
// nothing written yet has nothing to teach, and an archived one has been put
// away, so neither is offered.
export function listPromotableScripts(
  scripts: Script[],
  conversations: RawConversation[],
  examples: ExampleRecord[]
): PromotableScript[] {
  const conversationByScriptId = new Map(
    conversations.map(conversation => [conversation.scriptId, conversation])
  )
  const exampleByScriptId = new Map(
    examples
      .filter(example => example.sourceScriptId)
      .map(example => [example.sourceScriptId as string, example])
  )

  const promotable: PromotableScript[] = []
  for (const script of scripts) {
    if (script.isArchived) continue
    const conversation = conversationByScriptId.get(script.id)
    if (!conversation) continue
    const content = buildConsolidatedMarkdown(
      conversation,
      script.title,
      // Once complete the stored title is canonical, so a rename carries into
      // the corpus the same way it carries into an export
      script.status === 'complete' ? script.title : undefined
    )
    if (!content.trim()) continue

    const saved = exampleByScriptId.get(script.id)
    promotable.push({
      script,
      content,
      wordCount: countWords(content),
      savedExampleId: saved?.id,
      savedFolder: saved?.folder
    })
  }

  return promotable.sort(
    (a, b) => getScriptTimestamp(b.script) - getScriptTimestamp(a.script)
  )
}

// Pure: how a script reads in the picker — long enough to tell two drafts of
// the same brief apart, short enough for one line
export function describePromotableScript({
  script,
  wordCount,
  savedExampleId
}: PromotableScript): string {
  const words = `${wordCount.toLocaleString('en-US')} words`
  const state = savedExampleId ? ' · already saved' : ''
  return `${script.title} — ${words}${state}`
}
