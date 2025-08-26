import { useContext } from 'react'
import { ConversationContext } from '../contexts/ConversationContext'
import type { ConversationContextType } from '../contexts/ConversationContext'

export const useConversationContext = (): ConversationContextType => {
  const context = useContext(ConversationContext)
  if (!context) {
    throw new Error('useConversationContext must be used within a ConversationProvider')
  }
  return context
}