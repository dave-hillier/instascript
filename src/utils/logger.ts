/**
 * Diagnostic logger for debugging generation pipeline
 * Enable by setting localStorage.setItem('debug', 'true')
 * or by adding ?debug=true to URL
 */
export class Logger {
  private static isDebugEnabled(): boolean {
    // Check localStorage
    if (localStorage.getItem('debug') === 'true') return true
    
    // Check URL params
    const params = new URLSearchParams(window.location.search)
    if (params.get('debug') === 'true') {
      // Persist to localStorage for session
      localStorage.setItem('debug', 'true')
      return true
    }
    
    return false
  }

  static log(category: string, message: string, data?: unknown): void {
    if (!this.isDebugEnabled()) return
    
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1)
    const prefix = `[${timestamp}] [${category}]`
    
    if (data !== undefined) {
      console.log(prefix, message, data)
    } else {
      console.log(prefix, message)
    }
  }

  static error(category: string, message: string, error?: unknown): void {
    // Always log errors regardless of debug mode
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1)
    console.error(`[${timestamp}] [${category}] ERROR:`, message, error || '')
  }

  static warn(category: string, message: string, data?: unknown): void {
    // Always log warnings
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1)
    console.warn(`[${timestamp}] [${category}] WARN:`, message, data || '')
  }

  static time(label: string): void {
    if (!this.isDebugEnabled()) return
    console.time(label)
  }

  static timeEnd(label: string): void {
    if (!this.isDebugEnabled()) return
    console.timeEnd(label)
  }

  static group(label: string): void {
    if (!this.isDebugEnabled()) return
    console.group(label)
  }

  static groupEnd(): void {
    if (!this.isDebugEnabled()) return
    console.groupEnd()
  }

  static table(data: unknown): void {
    if (!this.isDebugEnabled()) return
    console.table(data)
  }

  // Utility to format data sizes
  static formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
  }

  // Utility to format durations
  static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60000).toFixed(1)}min`
  }
}