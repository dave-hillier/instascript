import { projectConversation } from '../services/scriptProjection'
import type { ProjectedSection } from '../services/scriptProjection'
import type { RawConversation } from '../types/conversation'

// The reading view's document: the shared projection plus the three flags that
// are about the request in flight rather than about the script. The fold itself
// lives in services/scriptProjection, which the export path reads too, so the
// page and the exported markdown can never disagree about what the script says.

export type ScriptDocumentSection = ProjectedSection

export interface ScriptDocument {
  title?: string
  sections: ScriptDocumentSection[]
  fullContent: string
  isGenerating: boolean
  hasError: boolean
  errorMessage?: string
}

export interface CurrentGeneration {
  conversationId: string
  isComplete: boolean
  error?: string
  sectionTitle?: string
}

export const getScriptDocument = (
  conversation: RawConversation | undefined,
  currentGeneration: CurrentGeneration | null
): ScriptDocument => {
  const projected = projectConversation(conversation, currentGeneration)

  // An error is reported whatever conversation it came from — the page shows
  // the failure it just triggered even when the reader has navigated on — but
  // the generating flag belongs to this conversation alone.
  const hasError = !!currentGeneration?.error
  const isGenerating = !!conversation && !!currentGeneration &&
    currentGeneration.conversationId === conversation.id &&
    !currentGeneration.isComplete

  // An empty conversation projects to an empty document with no title key at
  // all, which is what the page's "nothing to show yet" state has always been.
  if (!conversation?.generations?.length) {
    return { sections: [], fullContent: '', isGenerating: false, hasError, errorMessage: currentGeneration?.error }
  }

  return {
    title: projected.title,
    sections: projected.sections,
    fullContent: projected.fullContent,
    isGenerating,
    hasError,
    errorMessage: currentGeneration?.error
  }
}
