import { useReducer, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { RegenerationContext } from './RegenerationContext'
import type { RegenerationContextType } from './RegenerationContext'
import { regenerationReducer, initialRegenerationState } from '../reducers/regenerationReducer'
import type { MessageSubscription } from '../services/messageBus'

type RegenerationProviderProps = {
  children: ReactNode
}

export const RegenerationProvider = ({ children }: RegenerationProviderProps) => {
  const [state, dispatch] = useReducer(regenerationReducer, initialRegenerationState)
  const messageSubscriptionsRef = useRef<MessageSubscription[]>([])

  // Setup message bus subscriptions for essential events only
  useEffect(() => {
    // Currently no essential message bus events needed in RegenerationProvider
    // All state updates are handled directly by the service with reducer dispatch
    const subscriptions: MessageSubscription[] = []
    
    messageSubscriptionsRef.current = subscriptions
    
    return () => {
      subscriptions.forEach(sub => sub.unsubscribe())
    }
  }, [])

  const contextValue: RegenerationContextType = {
    state,
    dispatch
  }

  return (
    <RegenerationContext.Provider value={contextValue}>
      {children}
    </RegenerationContext.Provider>
  )
}