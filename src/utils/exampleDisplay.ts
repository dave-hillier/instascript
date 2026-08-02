// Presentation helpers shared by the examples page and its folder sections

// The datalist of existing folder names offered to every example's folder
// field, rendered once per page
export const FOLDER_SUGGESTIONS_ID = 'example-folder-suggestions'

// How often an example has actually informed a generation (story 8.11)
export const describeSelectionCount = (count: number): string => {
  if (count === 0) return 'Never selected for a generation'
  return `Selected for ${count} ${count === 1 ? 'generation' : 'generations'}`
}
