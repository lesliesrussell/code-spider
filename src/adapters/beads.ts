import { execSync } from 'node:child_process'

export interface BeadsDependency {
  issue_id: string
  depends_on_id: string
  type: string
}

export interface BeadsIssue {
  id: string
  title: string
  description?: string
  status?: string
  priority?: number
  issue_type?: string
  assignee?: string
  owner?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  close_reason?: string
  dependencies?: BeadsDependency[]
}

export class BeadsAdapter {
  constructor(private root: string) {}

  async listIssues(): Promise<BeadsIssue[]> {
    try {
      const output = execSync('bd list --all --json --readonly', {
        cwd: this.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 20 * 1024 * 1024,
      })
      const parsed = JSON.parse(output) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is BeadsIssue => (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { title?: unknown }).title === 'string'
      ))
    } catch {
      return []
    }
  }
}
