import type { RawConversation, Generation, ChatMessage } from '../types/conversation'

export const getStoredConversations = (): RawConversation[] => {
  try {
    const item = window.localStorage.getItem('conversations')
    return item ? JSON.parse(item) : []
  } catch (error) {
    console.warn('Error loading conversations from localStorage:', error)
    return []
  }
}

export const setStoredConversations = (conversations: RawConversation[]): void => {
  try {
    window.localStorage.setItem('conversations', JSON.stringify(conversations))
  } catch (error) {
    console.error('Error saving conversations to localStorage:', error)
  }
}

// Helper functions for working with generations
export const addGenerationToConversation = (
  conversations: RawConversation[], 
  conversationId: string, 
  generation: Generation
): RawConversation[] => {
  return conversations.map(conv =>
    conv.id === conversationId
      ? { ...conv, generations: [...conv.generations, generation], updatedAt: Date.now() }
      : conv
  )
}

export const updateLatestGeneration = (
  conversations: RawConversation[], 
  conversationId: string, 
  response: string,
  cachedTokens?: number
): RawConversation[] => {
  return conversations.map(conv =>
    conv.id === conversationId && conv.generations.length > 0
      ? { 
          ...conv, 
          generations: [
            ...conv.generations.slice(0, -1),
            {
              ...conv.generations[conv.generations.length - 1],
              response,
              cachedTokens
            }
          ],
          updatedAt: Date.now() 
        }
      : conv
  )
}

export const createRawConversation = (
  scriptId: string
): RawConversation => {
  return {
    id: `conv_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    scriptId,
    generations: [], // Will be populated when first generation is created
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export const getLatestGeneration = (conversation: RawConversation): Generation | undefined => {
  if (!conversation.generations || conversation.generations.length === 0) return undefined
  return conversation.generations[conversation.generations.length - 1]
}

export const getLatestResponse = (conversation: RawConversation): string => {
  const latest = getLatestGeneration(conversation)
  return latest?.response || ''
}

export const getLatestMessages = (conversation: RawConversation): ChatMessage[] => {
  const latest = getLatestGeneration(conversation)
  return latest?.messages || []
}