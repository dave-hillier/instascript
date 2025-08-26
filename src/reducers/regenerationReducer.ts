import type { 
  RegenerationState, 
  RegenerationAction, 
  SectionRegenerationState,
  RegenerationRules 
} from '../types/regeneration'

const defaultRules: RegenerationRules = {
  minimumWordCount: 400,
  maxAutoRegenerationAttempts: 3,
  regenerationCooldownMs: 30000 // 30 seconds
}

export const initialRegenerationState: RegenerationState = {
  rules: defaultRules,
  sectionStates: {},
  lastAnalysisTime: 0,
  totalRegenerationsRequested: 0
}

const createSectionState = (sectionKey: string): SectionRegenerationState => ({
  sectionKey,
  attempts: 0,
  lastRegenerationTime: 0,
  isInCooldown: false,
  nextEligibleTime: 0
})

export const regenerationReducer = (
  state: RegenerationState, 
  action: RegenerationAction
): RegenerationState => {
  const now = Date.now()

  switch (action.type) {
    case 'RULES_UPDATED':
      return {
        ...state,
        rules: { ...state.rules, ...action.rules }
      }

    case 'SECTION_STATE_INITIALIZED':
      return {
        ...state,
        sectionStates: {
          ...state.sectionStates,
          [action.sectionKey]: state.sectionStates[action.sectionKey] || createSectionState(action.sectionKey)
        }
      }

    case 'SECTION_ANALYZED': {
      const existingState = state.sectionStates[action.sectionKey] || createSectionState(action.sectionKey)
      
      return {
        ...state,
        lastAnalysisTime: now,
        sectionStates: {
          ...state.sectionStates,
          [action.sectionKey]: {
            ...existingState,
            // Update cooldown status based on current time
            isInCooldown: existingState.nextEligibleTime > now,
            nextEligibleTime: existingState.lastRegenerationTime > 0 
              ? existingState.lastRegenerationTime + state.rules.regenerationCooldownMs
              : 0
          }
        }
      }
    }

    case 'REGENERATION_ATTEMPTED': {
      const currentState = state.sectionStates[action.sectionKey] || createSectionState(action.sectionKey)
      const newAttempts = action.isManual ? 1 : currentState.attempts + 1 // Manual resets attempt count
      const nextEligibleTime = action.timestamp + state.rules.regenerationCooldownMs

      return {
        ...state,
        totalRegenerationsRequested: state.totalRegenerationsRequested + 1,
        sectionStates: {
          ...state.sectionStates,
          [action.sectionKey]: {
            ...currentState,
            attempts: newAttempts,
            lastRegenerationTime: action.timestamp,
            isInCooldown: true,
            nextEligibleTime
          }
        }
      }
    }

    case 'COOLDOWN_STARTED': {
      const sectionForCooldown = state.sectionStates[action.sectionKey] || createSectionState(action.sectionKey)
      
      return {
        ...state,
        sectionStates: {
          ...state.sectionStates,
          [action.sectionKey]: {
            ...sectionForCooldown,
            isInCooldown: true,
            nextEligibleTime: action.timestamp + action.duration
          }
        }
      }
    }

    case 'ATTEMPTS_RESET': {
      const sectionToReset = state.sectionStates[action.sectionKey]
      if (!sectionToReset) {
        // If section doesn't exist, no need to reset
        return state
      }

      return {
        ...state,
        sectionStates: {
          ...state.sectionStates,
          [action.sectionKey]: {
            ...sectionToReset,
            attempts: 0,
            // Keep timing info but reset attempts
            lastRegenerationTime: action.reason === 'manual_request' ? now : sectionToReset.lastRegenerationTime
          }
        }
      }
    }

    case 'TRACKING_DATA_CLEARED':
      return {
        ...state,
        sectionStates: {},
        lastAnalysisTime: 0,
        totalRegenerationsRequested: 0
      }

    case 'REGENERATION_STATS_REQUESTED':
      // This is a query action, no state changes
      // Stats would be computed by selectors
      return state

    default:
      return state
  }
}