import { useContext } from 'react'
import { RegenerationContext } from '../contexts/RegenerationContext'
import type { RegenerationContextType } from '../contexts/RegenerationContext'

export const useRegeneration = (): RegenerationContextType => {
  const context = useContext(RegenerationContext)
  if (context === undefined) {
    throw new Error('useRegeneration must be used within a RegenerationProvider')
  }
  return context
}