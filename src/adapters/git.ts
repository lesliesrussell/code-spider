import { execSync } from 'node:child_process'

export interface GitCommitRecord {
  hash: string
  timestamp: number
  subject: string
  files: string[]
}

export class GitAdapter {
  constructor(private root: string) {}

  async getHeadCommit(): Promise<string | null> {
    try {
      const result = execSync(`git -C ${JSON.stringify(this.root)} rev-parse HEAD`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return result.trim() || null
    } catch {
      return null
    }
  }

  async isDirty(): Promise<boolean | null> {
    try {
      const output = execSync(`git -C ${JSON.stringify(this.root)} status --porcelain`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return output.trim() !== ''
    } catch {
      return null
    }
  }

  async getChurn(maxFiles = 500): Promise<Map<string, number>> {
    const churnMap = new Map<string, number>()
    try {
      const output = execSync(
        `git -C ${JSON.stringify(this.root)} log --name-only --pretty=format: --since="6 months ago"`,
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 50 * 1024 * 1024,
        }
      )
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        churnMap.set(trimmed, (churnMap.get(trimmed) ?? 0) + 1)
      }

      // If over maxFiles, keep only the top N by churn count
      if (churnMap.size > maxFiles) {
        const sorted = [...churnMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxFiles)
        churnMap.clear()
        for (const [k, v] of sorted) {
          churnMap.set(k, v)
        }
      }
    } catch {
      // git not available or not a repo
    }
    return churnMap
  }

  async getRecency(): Promise<Map<string, number>> {
    const recencyMap = new Map<string, number>()
    try {
      const output = execSync(
        `git -C ${JSON.stringify(this.root)} log --name-only --pretty=format:%ct --diff-filter=M`,
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 50 * 1024 * 1024,
        }
      )

      const lines = output.split('\n')
      let currentTimestamp: number | null = null

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue

        // Lines that are all digits are timestamps
        if (/^\d+$/.test(trimmed)) {
          currentTimestamp = parseInt(trimmed, 10)
        } else if (currentTimestamp !== null) {
          // It's a file path — only keep the most recent timestamp
          const existing = recencyMap.get(trimmed)
          if (existing === undefined || currentTimestamp > existing) {
            recencyMap.set(trimmed, currentTimestamp)
          }
        }
      }
    } catch {
      // git not available or not a repo
    }
    return recencyMap
  }

  async getRecentHistory(maxCommits = 200): Promise<GitCommitRecord[]> {
    const commits: GitCommitRecord[] = []
    try {
      const output = execSync(
        `git -C ${JSON.stringify(this.root)} log --since="6 months ago" --max-count=${maxCommits} --name-only --pretty=format:__COMMIT__%n%H%n%ct%n%s`,
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 50 * 1024 * 1024,
        }
      )

      let current: GitCommitRecord | null = null
      let headerIndex = 0

      for (const rawLine of output.split('\n')) {
        const line = rawLine.trim()
        if (line === '__COMMIT__') {
          if (current !== null) commits.push(current)
          current = { hash: '', timestamp: 0, subject: '', files: [] }
          headerIndex = 0
          continue
        }
        if (current === null) continue

        if (headerIndex === 0) {
          current.hash = line
          headerIndex++
          continue
        }
        if (headerIndex === 1) {
          current.timestamp = parseInt(line, 10) || 0
          headerIndex++
          continue
        }
        if (headerIndex === 2) {
          current.subject = line
          headerIndex++
          continue
        }

        if (line !== '') {
          current.files.push(line)
        }
      }

      if (current !== null) commits.push(current)
    } catch {
      // git not available or not a repo
    }
    return commits.filter(commit => commit.hash !== '')
  }
}
