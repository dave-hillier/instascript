import YAML from 'yaml'
import type { Script } from '../types/script'

export function parseScriptFromYamlMarkdown(content: string): Script | null {
  if (!content) return null
  
  const blocks = content.split(/^---$/gm).filter(Boolean)
  
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    
    try {
      const parsed = YAML.parse(trimmed)
      
      if (parsed.type === 'script') {
        const nextBlock = blocks[blocks.indexOf(block) + 1]?.trim()
        
        return {
          id: parsed.id || '',
          title: parsed.title || 'Untitled',
          content: nextBlock || '',
          createdAt: parsed.createdAt || new Date().toISOString(),
          isArchived: parsed.isArchived || false,
          tags: parsed.tags,
          status: parsed.status,
          length: parsed.length,
          comments: parsed.comments,
          conversationId: parsed.conversationId,
          initialPrompt: parsed.initialPrompt,
          provider: parsed.provider,
          model: parsed.model
        }
      }
    } catch {
      continue
    }
  }
  
  return null
}

export function serializeScriptToYamlMarkdown(script: Script): string {
  const lines: string[] = []
  
  lines.push('---')
  lines.push(YAML.stringify({
    type: 'script',
    id: script.id,
    title: script.title,
    createdAt: script.createdAt,
    isArchived: script.isArchived,
    tags: script.tags,
    status: script.status,
    length: script.length,
    comments: script.comments,
    conversationId: script.conversationId,
    initialPrompt: script.initialPrompt,
    provider: script.provider,
    model: script.model
  }).trim())
  lines.push('---')
  lines.push(script.content)
  
  return lines.join('\n')
}

export function migrateScriptsToYamlMarkdown(scripts: Script[]): Map<string, string> {
  const scriptMap = new Map<string, string>()
  
  for (const script of scripts) {
    const yamlMarkdown = serializeScriptToYamlMarkdown(script)
    scriptMap.set(`script_${script.id}`, yamlMarkdown)
  }
  
  return scriptMap
}