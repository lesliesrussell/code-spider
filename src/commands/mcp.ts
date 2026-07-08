// code-spider-o7o
import type { CliContext } from '../types'
import { startMcpServer } from '../mcp/server'
import packageJson from '../../package.json'

export default async function run(ctx: CliContext): Promise<void> {
  // stdout is the MCP transport; anything human goes to stderr.
  console.error(`code-spider MCP server on stdio (repo: ${ctx.repoRoot})`)
  await startMcpServer({
    repoRoot: ctx.repoRoot,
    ...(typeof ctx.flags['db'] === 'string' ? { dbPath: ctx.dbPath } : {}),
    version: packageJson.version,
  })
}
