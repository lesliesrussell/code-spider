// code-spider-o7o code-spider-tnf
import type { CliContext } from '../types'
import { startMcpServer } from '../mcp/server'
import packageJson from '../../package.json'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export default async function run(ctx: CliContext): Promise<void> {
  // code-spider-tnf
  if (ctx.args[0] === 'install') {
    installProjectConfig(ctx.repoRoot)
    return
  }
  if (ctx.args.length > 0) {
    console.error(`Unknown mcp subcommand: ${ctx.args[0]}`)
    console.error('Usage: code-spider mcp [install]')
    process.exit(1)
  }

  // stdout is the MCP transport; anything human goes to stderr.
  console.error(`code-spider MCP server on stdio (repo: ${ctx.repoRoot})`)
  await startMcpServer({
    repoRoot: ctx.repoRoot,
    ...(typeof ctx.flags['db'] === 'string' ? { dbPath: ctx.dbPath } : {}),
    version: packageJson.version,
  })
}

// code-spider-tnf
// The MCP ecosystem's registration idiom: a project-scoped .mcp.json at the
// repo root, picked up automatically by Claude Code (and readable by other
// clients). Merge-preserving and idempotent. No --repo in args: the server
// defaults repoRoot to its launch cwd, which is the project root for every
// clone, so the file is committable.
function installProjectConfig(repoRoot: string): void {
  const configPath = join(repoRoot, '.mcp.json')

  let config: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) as typeof config
    } catch {
      console.error(`Existing ${configPath} is not valid JSON — fix or remove it, then re-run: code-spider mcp install`)
      process.exit(1)
    }
  }

  const servers = config.mcpServers ?? {}
  servers['code-spider'] = { command: 'code-spider', args: ['mcp'] }
  config.mcpServers = servers
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

  console.log(`Registered code-spider in ${configPath}`)
  console.log()
  console.log('Claude Code picks this up automatically on next launch (project scope —')
  console.log('commit .mcp.json to share it with the team).')
  console.log()
  console.log('Other clients:')
  console.log('  Claude Code, user scope:  claude mcp add --scope user code-spider -- code-spider mcp')
  console.log('  Claude Desktop / Cursor:  add the same command/args to their MCP settings')
  console.log()
  console.log('The server answers from the repo-local index; build it first with:')
  console.log('  code-spider index . --semantic --embed')
}
