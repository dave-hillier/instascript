type MessageType = 
  | 'REGENERATE_SECTION_REQUESTED'
  | 'SECTION_REGENERATION_STARTED'
  | 'SECTION_REGENERATION_COMPLETED'
  | 'SECTION_REGENERATION_FAILED'
  | 'SCRIPT_GENERATION_COMPLETED'
  | 'JOB_STATUS_CHANGED'

type MessagePayload = {
  REGENERATE_SECTION_REQUESTED: {
    scriptId: string
    sectionId: string
    sectionTitle: string
    conversationId: string
  }
  SECTION_REGENERATION_STARTED: {
    scriptId: string
    sectionId: string
    jobId: string
  }
  SECTION_REGENERATION_COMPLETED: {
    scriptId: string
    sectionId: string
    conversationId: string
    content: string
  }
  SECTION_REGENERATION_FAILED: {
    scriptId: string
    sectionId: string
    error: string
  }
  SCRIPT_GENERATION_COMPLETED: {
    conversationId: string
    scriptId: string
  }
  JOB_STATUS_CHANGED: {
    jobId: string
    status: string
    type: string
  }
}

type MessageHandler<T extends MessageType> = (payload: MessagePayload[T]) => void

type MessageSubscription = {
  unsubscribe: () => void
}

class MessageBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>()

  subscribe<T extends MessageType>(
    messageType: T,
    handler: MessageHandler<T>
  ): MessageSubscription {
    if (!this.handlers.has(messageType)) {
      this.handlers.set(messageType, new Set())
    }
    
    const handlers = this.handlers.get(messageType)!
    const wrappedHandler = (payload: unknown) => {
      handler(payload as MessagePayload[T])
    }
    handlers.add(wrappedHandler)
    
    return {
      unsubscribe: () => {
        handlers.delete(wrappedHandler)
        if (handlers.size === 0) {
          this.handlers.delete(messageType)
        }
      }
    }
  }

  publish<T extends MessageType>(messageType: T, payload: MessagePayload[T]): void {
    const handlers = this.handlers.get(messageType)
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(payload)
        } catch (error) {
          console.error(`Error in message handler for ${messageType}:`, error)
        }
      })
    }
  }

  // Get current subscriber count for debugging
  getSubscriberCount(messageType: MessageType): number {
    return this.handlers.get(messageType)?.size || 0
  }

  // Clear all subscriptions (useful for testing)
  clear(): void {
    this.handlers.clear()
  }
}

// Single instance for the entire app
export const messageBus = new MessageBus()

// Type exports for consumers
export type { MessageType, MessagePayload, MessageSubscription }