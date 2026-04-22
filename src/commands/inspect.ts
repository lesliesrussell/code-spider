import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { Indexer } from '../services/indexer'

export default async function run(ctx: CliContext): Promise<void> {
  const targetPath = ctx.args[0] !== undefined ? resolve(ctx.args[0]) : ctx.repoRoot
  const usesCustomDb = typeof ctx.flags['db'] === 'string'
  const tempDir = usesCustomDb ? null : mkdtempSync(join(tmpdir(), 'code-spider-inspect-'))
  const dbPath = usesCustomDb
    ? ctx.dbPath
    : resolve(tempDir ?? targetPath, 'index.db')

  const indexer = new Indexer()

  try {
    if (!ctx.json) {
      const modeLabel = usesCustomDb ? dbPath : 'temporary database'
      console.log(`Inspecting ${targetPath} (${modeLabel})...`)
    }

    await indexer.run({
      repoRoot: targetPath,
      dbPath,
    })

    const overviewCtx: CliContext = {
      ...ctx,
      repoRoot: targetPath,
      dbPath,
      args: [],
    }

    const overview = await import('./overview')
    await overview.default(overviewCtx)
  } finally {
    if (tempDir !== null) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}
