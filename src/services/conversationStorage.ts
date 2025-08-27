import type { Conversation } from '../types/conversation'

export const getStoredConversations = (): Conversation[] => {
  try {
    const item = window.localStorage.getItem('conversations')
    return item ? JSON.parse(item) : []
  } catch (error) {
    console.warn('Error loading conversations from localStorage:', error)
    return []
  }
}

export const setStoredConversations = (conversations: Conversation[]): void => {
  try {
    window.localStorage.setItem('conversations', JSON.stringify(conversations))
  } catch (error) {
    console.error('Error saving conversations to localStorage:', error)
  }
}