import { execSync } from 'node:child_process'

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
}
