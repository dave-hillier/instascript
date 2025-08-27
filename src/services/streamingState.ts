
export interface SectionInProgress {
  sectionId: string
  startPosition: number
  currentTitle: string
  hasCreatedSection: boolean
}

export class StreamingState {
  private conversationId: string
  private lastProcessedPosition: number = 0
  private currentSection: SectionInProgress | null = null
  private titleDetected: boolean = false
  private titleLineCompleted: boolean = false

  constructor(conversationId: string) {
    this.conversationId = conversationId
  }

  // Get the position where we last finished processing content
  getLastProcessedPosition(): number {
    return this.lastProcessedPosition
  }

  // Update the position we've processed up to
  setLastProcessedPosition(position: number): void {
    this.lastProcessedPosition = position
  }

  // Check if we've detected a title for this conversation
  hasTitleBeenDetected(): boolean {
    return this.titleDetected
  }

  // Mark that we've detected a title
  markTitleDetected(): void {
    this.titleDetected = true
  }

  // Check if the title line has been completed (has newline after it)
  hasTitleLineCompleted(): boolean {
    return this.titleLineCompleted
  }

  // Mark that the title line is complete and we should stop processing it
  markTitleLineCompleted(): void {
    this.titleLineCompleted = true
  }

  // Get the current section being built (if any)
  getCurrentSection(): SectionInProgress | null {
    return this.currentSection
  }

  // Start tracking a new section
  startNewSection(startPosition: number, initialTitle: string): SectionInProgress {
    this.currentSection = {
      sectionId: `section_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      startPosition,
      currentTitle: initialTitle,
      hasCreatedSection: false
    }
    return this.currentSection
  }

  // Update the current section's title
  updateCurrentSectionTitle(newTitle: string): void {
    if (this.currentSection) {
      this.currentSection.currentTitle = newTitle
    }
  }

  // Mark that the current section has been created in the conversation
  markCurrentSectionCreated(): void {
    if (this.currentSection) {
      this.currentSection.hasCreatedSection = true
    }
  }

  // Clear the current section (when moving to next section)
  clearCurrentSection(): void {
    this.currentSection = null
  }

  // Reset all state (for regeneration or new conversation)
  reset(): void {
    this.lastProcessedPosition = 0
    this.currentSection = null
    this.titleDetected = false
    this.titleLineCompleted = false
  }

  // Check if we should create a new section or update existing one
  shouldCreateNewSection(sectionTitle: string): boolean {
    // Always create if no current section
    if (!this.currentSection) {
      console.debug('shouldCreateNewSection: no current section, creating new')
      return true
    }

    const currentTitle = this.currentSection.currentTitle
    const newStartsWithCurrent = sectionTitle.startsWith(currentTitle)
    const currentStartsWithNew = currentTitle.startsWith(sectionTitle)
    const shouldCreate = !newStartsWithCurrent && !currentStartsWithNew
    
    console.debug('shouldCreateNewSection logic', {
      currentTitle,
      sectionTitle,
      newStartsWithCurrent,
      currentStartsWithNew,
      shouldCreate
    })

    // If the new title doesn't start with current title, it's a new section
    // E.g. current: "Visual", new: "Audio" -> new section
    // E.g. current: "Visual", new: "Visualization" -> same section (extends)
    // E.g. current: "Visualization", new: "Visual" -> same section (truncates)
    return shouldCreate
  }

  getConversationId(): string {
    return this.conversationId
  }
}