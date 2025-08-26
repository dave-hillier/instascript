import { useContext } from 'react'
import { ServiceContext } from '../contexts/ServiceContext'
import type { ServiceContextType } from '../contexts/ServiceContext'

export function useServices(): ServiceContextType {
  const context = useContext(ServiceContext)
  if (!context) {
    throw new Error('useServices must be used within a ServiceProvider')
  }
  return context
}