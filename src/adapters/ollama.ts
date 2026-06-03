// code-spider-403
// Embed-only ollama client. Local-first: talks to the user's own ollama at
// localhost:11434 (CODE_SPIDER_OLLAMA_URL overrides). Fail-soft per design
// constraints — any failure returns null and the caller degrades to
// structural signals; nothing here may throw into a command.
import { debugLog } from '../utils/debug'

export const EMBEDDING_MODEL = 'nomic-embed-text'

function baseUrl(): string {
  return process.env['CODE_SPIDER_OLLAMA_URL'] ?? 'http://localhost:11434'
}

export interface Embedder {
  embed(text: string): Promise<number[] | null>
  isAvailable(): Promise<{ reachable: boolean; modelPresent: boolean }>
}

export class OllamaAdapter implements Embedder {
  constructor(private readonly model = EMBEDDING_MODEL) {}

  async embed(text: string): Promise<number[] | null> {
    try {
      const response = await fetch(`${baseUrl()}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) {
        debugLog('ollama', `embeddings request failed: HTTP ${response.status}`)
        return null
      }
      const payload = await response.json() as { embedding?: number[] }
      if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
        debugLog('ollama', 'embeddings response missing vector')
        return null
      }
      return payload.embedding
    } catch (err) {
      debugLog('ollama', 'embeddings request failed', err)
      return null
    }
  }

  async isAvailable(): Promise<{ reachable: boolean; modelPresent: boolean }> {
    try {
      const response = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(2000) })
      if (!response.ok) return { reachable: false, modelPresent: false }
      const payload = await response.json() as { models?: Array<{ name?: string }> }
      const modelPresent = (payload.models ?? []).some(entry =>
        typeof entry.name === 'string' && entry.name.startsWith(this.model)
      )
      return { reachable: true, modelPresent }
    } catch (err) {
      debugLog('ollama', 'availability probe failed', err)
      return { reachable: false, modelPresent: false }
    }
  }
}
