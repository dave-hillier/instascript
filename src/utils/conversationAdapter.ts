import type { RawConversation, Conversation, Message } from '../types/conversation'
import { deriveConversationState } from './responseParser'

/**
 * Convert a RawConversation to a legacy Conversation format for compatibility
 * with existing services that expect the old structure
 */
export const adaptRawToLegacyConversation = (rawConversation: RawConversation): Conversation => {
  const parsedDocument = deriveConversationState(rawConversation)
  
  // Build messages from the stored generations
  const messages: Message[] = []
  
  if (rawConversation.generations && rawConversation.generations.length > 0) {
    // Use the actual stored messages from the latest generation
    const latestGeneration = rawConversation.generations[rawConversation.generations.length - 1]
    
    latestGeneration.messages.forEach((msg, index) => {
      messages.push({
        id: `msg_${rawConversation.id}_${index}`,
        role: msg.role,
        content: msg.content,
        timestamp: latestGeneration.timestamp
      })
    })
    
    // Add the assistant response as the final message if it's not already there
    if (latestGeneration.response && 
        (messages.length === 0 || messages[messages.length - 1].role !== 'assistant')) {
      messages.push({
        id: `msg_${rawConversation.id}_response`,
        role: 'assistant',
        content: latestGeneration.response,
        timestamp: latestGeneration.timestamp
      })
    }
  }
  
  // Convert parsed sections to legacy format
  const sections = parsedDocument?.sections.map(section => ({
    id: `section_${section.title.replace(/\s+/g, '_').toLowerCase()}`,
    title: section.title,
    content: section.content,
    status: 'completed' as const,
    messageIds: messages.filter(m => m.role === 'assistant').map(m => m.id),
    wasRegenerated: false
  })) || []
  
  return {
    id: rawConversation.id,
    scriptId: rawConversation.scriptId,
    title: parsedDocument?.header.title,
    messages,
    sections,
    status: 'completed',
    createdAt: rawConversation.createdAt,
    updatedAt: rawConversation.updatedAt
  }
}