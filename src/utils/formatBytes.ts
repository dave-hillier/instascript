// Sizes as a person would say them: whole kilobytes, and megabytes to one
// decimal until they are big enough not to need it.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`
  const megabytes = kilobytes / 1024
  return megabytes < 100 ? `${megabytes.toFixed(1)} MB` : `${Math.round(megabytes)} MB`
}
