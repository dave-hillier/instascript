import type { RawConversation, ChatMessage, Generation, GenerationPhase, ReviewReport, ScriptOutline } from '../types/conversation'

export type RawConversationAction =
  | { type: 'LOAD_CONVERSATIONS'; conversations: RawConversation[] }
  | { type: 'CREATE_CONVERSATION'; conversation: RawConversation }
  | { type: 'SECTION_EDITED'; conversationId: string; generation: Generation }
  | { type: 'START_GENERATION'; conversationId: string; messages: ChatMessage[]; exampleIds?: string[] }
  | { type: 'UPDATE_CURRENT_GENERATION'; conversationId: string; response: string; cachedTokens?: number }
  | { type: 'COMPLETE_GENERATION'; conversationId: string; response: string; cachedTokens?: number }
  | { type: 'DELETE_CONVERSATION'; conversationId: string }
  | { type: 'CONVERSATIONS_CLEARED' }
  | { type: 'GENERATION_RESTARTED'; conversationId: string }
  | { type: 'GENERATIONS_DISCARDED'; conversationId: string }
  | { type: 'SET_GENERATION_PROGRESS'; conversationId: string; isComplete: boolean; error?: string; sectionTitle?: string }
  | { type: 'SET_GENERATION_PHASE'; conversationId: string; phase: GenerationPhase; outline?: ScriptOutline; currentSectionIndex?: number; totalSections?: number; sectionWordCounts?: number[]; error?: string }
  | { type: 'REVIEW_PASS_COMPLETED'; report: ReviewReport }
  | { type: 'REVIEW_REPORT_DISMISSED' }

export type RawConversationState = {
  conversations: RawConversation[]
  currentGeneration: {
    conversationId: string
    isComplete: boolean
    error?: string
    sectionTitle?: string
  } | null
  generationMachine: {
    phase: GenerationPhase
    conversationId: string
    outline: ScriptOutline | null
    currentSectionIndex: number
    totalSections: number
    sectionWordCounts: number[]
    error?: string
  } | null
  // The outcome of the latest style-review pass (story 8.5), until dismissed
  reviewReport: ReviewReport | null
}

export const rawConversationReducer = (
  state: RawConversationState,
  action: RawConversationAction
): RawConversationState => {
  switch (action.type) {
    case 'LOAD_CONVERSATIONS': {
      // Loading is async, so a conversation may already have been created
      // (and be generating) before storage finishes loading — keep those,
      // merging the loaded ones underneath
      const existingIds = new Set(state.conversations.map(conv => conv.id))
      const loaded = action.conversations.filter(conv => !existingIds.has(conv.id))
      return { ...state, conversations: [...loaded, ...state.conversations] }
    }

    case 'CREATE_CONVERSATION':
      return {
        ...state,
        conversations: [...state.conversations, action.conversation]
      }

    case 'SECTION_EDITED':
      // A manual edit is stored as a completed generation of its own, so
      // consolidation-by-title replaces the section and regeneration history
      // includes the edited text
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? {
                ...conv,
                generations: [...conv.generations, action.generation],
                updatedAt: Date.now()
              }
            : conv
        )
      }

    case 'START_GENERATION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? {
                ...conv,
                generations: [...conv.generations, {
                  messages: action.messages,
                  response: '',
                  timestamp: Date.now(),
                  exampleIds: action.exampleIds
                }],
                updatedAt: Date.now()
              }
            : conv
        )
      }

    case 'UPDATE_CURRENT_GENERATION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId && conv.generations.length > 0
            ? {
                ...conv,
                generations: [
                  ...conv.generations.slice(0, -1),
                  {
                    ...conv.generations[conv.generations.length - 1],
                    response: action.response,
                    cachedTokens: action.cachedTokens
                  }
                ],
                updatedAt: Date.now()
              }
            : conv
        )
      }


    case 'COMPLETE_GENERATION':
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId && conv.generations.length > 0
            ? {
                ...conv,
                generations: [
                  ...conv.generations.slice(0, -1),
                  {
                    ...conv.generations[conv.generations.length - 1],
                    response: action.response,
                    cachedTokens: action.cachedTokens
                  }
                ],
                updatedAt: Date.now()
              }
            : conv
        )
      }

    case 'DELETE_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.filter(conv => conv.id !== action.conversationId)
      }

    case 'CONVERSATIONS_CLEARED':
      // Clear All Conversations wiped persistent storage; drop the in-memory
      // copies too so nothing stale is re-saved or blocks a later import
      return {
        ...state,
        conversations: [],
        currentGeneration: null,
        generationMachine: null,
        reviewReport: null
      }

    case 'GENERATIONS_DISCARDED':
      // The user chose an explicit full restart (story 1.8): drop the
      // conversation's outline and section generations so the new run's
      // document is not polluted by sections from the abandoned plan
      return {
        ...state,
        conversations: state.conversations.map(conv =>
          conv.id === action.conversationId
            ? { ...conv, generations: [], updatedAt: Date.now() }
            : conv
        )
      }

    case 'GENERATION_RESTARTED':
      // A fresh generation run is starting: clear any completed/errored state
      // so progress updates for the new run are not blocked or misattributed,
      // and drop a review report that no longer describes the current script
      return {
        ...state,
        currentGeneration: null,
        generationMachine: null,
        reviewReport: null
      }

    case 'SET_GENERATION_PROGRESS':
      // Prevent reverting completion state - once complete, stay complete
      if (state.currentGeneration?.conversationId === action.conversationId &&
          state.currentGeneration?.isComplete &&
          !action.isComplete) {
        return state
      }

      return {
        ...state,
        currentGeneration: {
          conversationId: action.conversationId,
          isComplete: action.isComplete,
          error: action.error,
          sectionTitle: action.sectionTitle
        }
      }

    case 'SET_GENERATION_PHASE':
      return {
        ...state,
        generationMachine: {
          phase: action.phase,
          conversationId: action.conversationId,
          outline: action.outline ?? state.generationMachine?.outline ?? null,
          currentSectionIndex: action.currentSectionIndex ?? state.generationMachine?.currentSectionIndex ?? 0,
          totalSections: action.totalSections ?? state.generationMachine?.totalSections ?? 0,
          sectionWordCounts: action.sectionWordCounts ?? state.generationMachine?.sectionWordCounts ?? [],
          error: action.error
        }
      }

    case 'REVIEW_PASS_COMPLETED':
      return { ...state, reviewReport: action.report }

    case 'REVIEW_REPORT_DISMISSED':
      return { ...state, reviewReport: null }

    default:
      return state
  }
}
