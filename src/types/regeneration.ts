export type RegenerationRules = {
  minimumWordCount: number
  maxAutoRegenerationAttempts: number
  regenerationCooldownMs: number
}

export type SectionRegenerationState = {
  sectionKey: string // scriptId:sectionId format
  attempts: number
  lastRegenerationTime: number
  isInCooldown: boolean
  nextEligibleTime: number
}

export type SectionAnalysis = {
  sectionId: string
  sectionTitle: string
  wordCount: number
  needsRegeneration: boolean
  reason?: string
  attempts: number
  isInCooldown: boolean
}

export type RegenerationState = {
  rules: RegenerationRules
  sectionStates: Record<string, SectionRegenerationState> // keyed by sectionKey
  lastAnalysisTime: number
  totalRegenerationsRequested: number
}

export type RegenerationAction = 
  | { type: 'RULES_UPDATED'; rules: Partial<RegenerationRules> }
  | { type: 'SECTION_ANALYZED'; sectionKey: string; analysis: { wordCount: number; needsRegeneration: boolean } }
  | { type: 'REGENERATION_ATTEMPTED'; sectionKey: string; timestamp: number; isManual: boolean }
  | { type: 'COOLDOWN_STARTED'; sectionKey: string; timestamp: number; duration: number }
  | { type: 'ATTEMPTS_RESET'; sectionKey: string; reason: 'manual_request' | 'admin_reset' }
  | { type: 'SECTION_STATE_INITIALIZED'; sectionKey: string }
  | { type: 'TRACKING_DATA_CLEARED'; reason: 'test' | 'admin' }
  | { type: 'REGENERATION_STATS_REQUESTED' } // for debugging/logging