// code-spider-o7o
// MCP stdio server exposing the code-spider knowledge graph to agents.
// One long-lived process per repo: the DB stays open across queries and
// agents skip the per-call CLI spawn. Started via `code-spider mcp
// [--repo <path>] [--db <path>]`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { McpCommandError, runCommand } from './run-command'

interface McpServerOptions {
  repoRoot: string
  dbPath?: string
  version: string
}

interface ToolSpec {
  name: string
  command: string
  description: string
  args?: (input: Record<string, unknown>) => string[]
  flags?: (input: Record<string, unknown>) => Record<string, string | boolean>
  schema: Record<string, z.ZodTypeAny>
}

const limitSchema = z.number().int().positive().optional().describe('Maximum results to return')

const nodeRefDescription =
  'Node reference in kind:key form, e.g. repo:., zone:src, unit:src/index.ts, atom:AuthService.authenticate'

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

function optionalFlags(input: Record<string, unknown>, names: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (const name of names) {
    const value = input[name]
    if (value === undefined) continue
    flags[name] = typeof value === 'boolean' ? value : String(value)
  }
  return flags
}

const TOOLS: ToolSpec[] = [
  {
    name: 'overview',
    command: 'overview',
    description: 'Repo overview: languages, zones, top hotspot files by churn/LOC score.',
    schema: {},
  },
  {
    name: 'zones',
    command: 'zones',
    description: 'List top-level zones (directories) with file counts and scores.',
    schema: { limit: limitSchema },
    flags: input => optionalFlags(input, ['limit']),
  },
  {
    name: 'show',
    command: 'show',
    description: 'Show one node with stats, git context, docs context, tracked issues, and evidence.',
    schema: { ref: z.string().describe(nodeRefDescription) },
    args: input => [str(input['ref'])],
  },
  {
    name: 'children',
    command: 'children',
    description: 'List children of a node, sortable by score, churn, loc, or recency.',
    schema: {
      ref: z.string().describe(nodeRefDescription),
      limit: limitSchema,
      sort: z.enum(['score', 'churn', 'loc', 'recent']).optional(),
    },
    args: input => [str(input['ref'])],
    flags: input => optionalFlags(input, ['limit', 'sort']),
  },
  {
    name: 'related',
    command: 'related',
    description: 'Nodes related to a node via shared symbols, co-change, docs, topology, or meaning.',
    schema: {
      ref: z.string().describe(nodeRefDescription),
      kind: z.string().optional().describe('Restrict to one signal kind, e.g. meaning'),
      limit: limitSchema,
    },
    args: input => [str(input['ref'])],
    flags: input => optionalFlags(input, ['kind', 'limit']),
  },
  {
    name: 'flows',
    command: 'flows',
    description: 'Detected flows (CLI commands, routes, queues, events) across the repo or for one node.',
    schema: { ref: z.string().optional().describe(nodeRefDescription), limit: limitSchema },
    args: input => (input['ref'] !== undefined ? [str(input['ref'])] : []),
    flags: input => optionalFlags(input, ['limit']),
  },
  {
    name: 'find',
    command: 'find',
    description: 'Natural-language semantic search over embedded units. Requires an --embed index.',
    schema: { query: z.string().describe('Natural language query'), limit: limitSchema },
    args: input => [str(input['query'])],
    flags: input => optionalFlags(input, ['limit']),
  },
  {
    name: 'refs',
    command: 'refs',
    description: 'References to a symbol. indexedOnly answers from the index in milliseconds (symbol-edge granularity); otherwise live LSP.',
    schema: { symbol: z.string(), indexedOnly: z.boolean().optional() },
    args: input => [str(input['symbol'])],
    flags: input => (input['indexedOnly'] === true ? { 'indexed-only': true } : ({} as Record<string, string | boolean>)),
  },
  {
    name: 'defs',
    command: 'defs',
    description: 'Definitions of a symbol. indexedOnly skips live LSP.',
    schema: { symbol: z.string(), indexedOnly: z.boolean().optional() },
    args: input => [str(input['symbol'])],
    flags: input => (input['indexedOnly'] === true ? { 'indexed-only': true } : ({} as Record<string, string | boolean>)),
  },
  {
    name: 'atoms',
    command: 'atoms',
    description: 'Symbols (functions, classes, constants) defined inside a unit.',
    schema: { ref: z.string().describe('Unit reference, e.g. unit:src/index.ts') },
    args: input => [str(input['ref'])],
  },
  {
    name: 'intelligence_scan',
    command: 'intelligence',
    description: 'Static-analysis findings: dead code, cycles, duplication, hotspots, architecture violations.',
    schema: {
      category: z.enum(['scan', 'cycles', 'unused', 'dupes', 'hotspots', 'arch']).optional()
        .describe('Finding family; default scan (all)'),
    },
    args: input => [str(input['category'] ?? 'scan')],
  },
  {
    name: 'doctor',
    command: 'doctor',
    description: 'Environment and capability health: which analyzers are available and whether semantic data is trustworthy.',
    schema: {},
  },
]

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const server = new McpServer({ name: 'code-spider', version: options.version })

  for (const tool of TOOLS) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (input: Record<string, unknown>) => {
        try {
          const output = await runCommand({
            command: tool.command,
            args: tool.args?.(input) ?? [],
            flags: tool.flags?.(input) ?? {},
            repoRoot: options.repoRoot,
            ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
          })
          return { content: [{ type: 'text' as const, text: output || '(no output)' }] }
        } catch (err) {
          const message = err instanceof McpCommandError ? err.message : `Internal error: ${String(err)}`
          return { content: [{ type: 'text' as const, text: message }], isError: true }
        }
      },
    )
  }

  await server.connect(new StdioServerTransport())
}
