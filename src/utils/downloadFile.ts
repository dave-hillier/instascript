// Handing a generated file to the browser.
//
// Naming a downloaded blob means clicking an anchor at it — there is no other
// API for it — so the one place that touches the document lives here rather
// than in the components that export things. The object URL is released as
// soon as the click has taken it.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
