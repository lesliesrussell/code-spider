import { Database } from 'bun:sqlite'

export interface Flow {
  key: string
  label: string
  kind: string
  confidence: number
  nodes: string[]
  evidence: string[]
}

interface FlowScope {
  label: string
  nodeKeys: Set<string>
}

interface SymbolRow {
  name: string
  kind: string
  node_key: string
  node_path: string | null
}

interface NodeRow {
  key: string
  path: string | null
  label: string
}

function confidenceFromHits(count: number): number {
  if (count >= 4) return 0.9
  if (count >= 2) return 0.6
  return 0.3
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export class FlowDetector {
  constructor(private db: Database, private runId: number) {}

  async detect(repoRoot: string, nodeRef?: string): Promise<Flow[]> {
    const flows: Flow[] = []

    const routeFlows = await this.detectRoutes(repoRoot)
    const eventFlows = this.detectEvents()
    const cliFlows = await this.detectCli(repoRoot)

    flows.push(...routeFlows, ...eventFlows, ...cliFlows)

    // Deduplicate by label
    const seen = new Map<string, Flow>()
    for (const f of flows) {
      const existing = seen.get(f.label)
      if (!existing || f.confidence > existing.confidence) {
        seen.set(f.label, f)
      }
    }

    const deduped = Array.from(seen.values())
    const scope = this.resolveScope(nodeRef)
    const filtered = scope === null
      ? deduped
      : deduped.flatMap(flow => this.filterFlow(flow, scope))

    return filtered.slice(0, 20)
  }

  private resolveScope(nodeRef?: string): FlowScope | null {
    if (!nodeRef || nodeRef === 'repo:.') {
      return null
    }

    if (nodeRef.startsWith('zone:')) {
      const zoneName = nodeRef.slice('zone:'.length)
      const rows = this.db.query<{ key: string }, [number, string]>(
        `SELECT key FROM nodes
         WHERE run_id=? AND kind='unit' AND path LIKE ?`
      ).all(this.runId, `${zoneName}/%`)

      return {
        label: nodeRef,
        nodeKeys: new Set(rows.map(row => row.key)),
      }
    }

    return {
      label: nodeRef,
      nodeKeys: new Set([nodeRef]),
    }
  }

  private filterFlow(flow: Flow, scope: FlowScope): Flow[] {
    const matchingNodes = flow.nodes.filter(nodeKey => scope.nodeKeys.has(nodeKey))
    if (matchingNodes.length === 0) {
      return []
    }

    const matchingEvidence = flow.evidence.filter(item => this.evidenceMatchesScope(item, scope))
    return [{
      ...flow,
      nodes: matchingNodes,
      evidence: matchingEvidence.length > 0 ? matchingEvidence : flow.evidence,
    }]
  }

  private evidenceMatchesScope(evidence: string, scope: FlowScope): boolean {
    if (scope.label.startsWith('zone:')) {
      const zoneName = scope.label.slice('zone:'.length)
      return evidence.includes(`${zoneName}/`)
    }

    if (scope.label.startsWith('unit:')) {
      const unitPath = scope.label.slice('unit:'.length)
      return evidence.includes(unitPath)
    }

    return evidence.includes(scope.label)
  }

  private async detectRoutes(repoRoot: string): Promise<Flow[]> {
    const flows: Flow[] = []
    const evidence: string[] = []
    const nodeKeys: string[] = []

    // Try ripgrep for route patterns
    let rgOutput = ''
    try {
      const proc = Bun.spawn(
        ['rg', '--json', '-i', '--glob', '!node_modules', 'router\\.(get|post|put|delete|patch)|app\\.(get|post|put|delete|patch)', repoRoot],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const bytes = await new Response(proc.stdout).arrayBuffer()
      rgOutput = new TextDecoder().decode(bytes)
    } catch {
      // rg not available, fall through to symbol query
    }

    if (rgOutput) {
      for (const line of rgOutput.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string } } }
          if (parsed.type === 'match' && parsed.data?.path?.text) {
            const filePath = parsed.data.path.text
            const snippet = parsed.data.lines?.text?.trim() ?? ''
            evidence.push(`${filePath}: ${snippet}`.slice(0, 120))
            // Find matching node
            const node = this.db.query<NodeRow, [number, string]>(
              `SELECT key, path, label FROM nodes WHERE run_id=? AND path=? AND kind='unit' LIMIT 1`
            ).get(this.runId, filePath.replace(repoRoot + '/', ''))
            if (node && !nodeKeys.includes(node.key)) {
              nodeKeys.push(node.key)
            }
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    // Also query symbols for route/handler/controller/endpoint names
    const routeSymbols = this.db.query<SymbolRow, [number, string, string, string, string]>(
      `SELECT s.name, s.kind, n.key as node_key, n.path as node_path
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id=? AND (
         s.name LIKE ? OR s.name LIKE ? OR s.name LIKE ? OR s.name LIKE ?
       ) LIMIT 50`
    ).all(this.runId, '%route%', '%handler%', '%controller%', '%endpoint%')

    for (const sym of routeSymbols) {
      evidence.push(`symbol: ${sym.name} (${sym.kind}) in ${sym.node_path ?? sym.node_key}`)
      if (!nodeKeys.includes(sym.node_key)) {
        nodeKeys.push(sym.node_key)
      }
    }

    // File-based routing: route.ts, routes.ts, [slug].ts, page.tsx
    const routeFileNodes = this.db.query<NodeRow, [number, string, string, string, string, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND (
         path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ?
       ) LIMIT 20`
    ).all(this.runId, '%/route.ts', '%/routes.ts', '%/route.tsx', '%/page.tsx', '%/routes.js')

    for (const n of routeFileNodes) {
      evidence.push(`file: ${n.path ?? n.label}`)
      if (!nodeKeys.includes(n.key)) {
        nodeKeys.push(n.key)
      }
    }

    if (evidence.length > 0 || nodeKeys.length > 0) {
      flows.push({
        key: 'flow:http-routes',
        label: 'http-routes',
        kind: 'request',
        confidence: confidenceFromHits(evidence.length + nodeKeys.length),
        nodes: nodeKeys.slice(0, 10),
        evidence: evidence.slice(0, 10),
      })
    }

    return flows
  }

  private detectEvents(): Flow[] {
    const flows: Flow[] = []

    const patterns = [
      { match: ['%queue%', '%worker%', '%job%', '%consumer%', '%producer%'], label: 'queue-workers', kind: 'worker' },
      { match: ['%event%', '%emit%', '%publish%', '%subscribe%'], label: 'event-bus', kind: 'event' },
    ]

    for (const pattern of patterns) {
      const evidence: string[] = []
      const nodeKeys: string[] = []

      // Check symbols
      const symbols = this.db.query<SymbolRow, [number, ...string[]]>(
        `SELECT s.name, s.kind, n.key as node_key, n.path as node_path
         FROM symbols s
         JOIN nodes n ON n.id = s.node_id
         WHERE s.run_id=? AND (${pattern.match.map(() => 's.name LIKE ?').join(' OR ')}) LIMIT 30`
      ).all(this.runId, ...pattern.match)

      for (const sym of symbols) {
        evidence.push(`symbol: ${sym.name} (${sym.kind}) in ${sym.node_path ?? sym.node_key}`)
        if (!nodeKeys.includes(sym.node_key)) {
          nodeKeys.push(sym.node_key)
        }
      }

      // Check file names
      const fileNodes = this.db.query<NodeRow, [number, ...string[]]>(
        `SELECT key, path, label FROM nodes
         WHERE run_id=? AND kind='unit' AND (${pattern.match.map(() => 'path LIKE ?').join(' OR ')}) LIMIT 10`
      ).all(this.runId, ...pattern.match)

      for (const n of fileNodes) {
        evidence.push(`file: ${n.path ?? n.label}`)
        if (!nodeKeys.includes(n.key)) {
          nodeKeys.push(n.key)
        }
      }

      if (evidence.length > 0 || nodeKeys.length > 0) {
        flows.push({
          key: `flow:${pattern.label}`,
          label: pattern.label,
          kind: pattern.kind,
          confidence: confidenceFromHits(evidence.length + nodeKeys.length),
          nodes: nodeKeys.slice(0, 10),
          evidence: evidence.slice(0, 10),
        })
      }
    }

    return flows
  }

  private async detectCli(repoRoot: string): Promise<Flow[]> {
    const flows: Flow[] = []
    const evidence: string[] = []
    const nodeKeys: string[] = []

    // Check for CLI patterns via ripgrep
    let rgOutput = ''
    try {
      const proc = Bun.spawn(
        ['rg', '--json', '-i', '--glob', '!node_modules', 'process\\.argv|parseArgs|commander|yargs', repoRoot],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const bytes = await new Response(proc.stdout).arrayBuffer()
      rgOutput = new TextDecoder().decode(bytes)
    } catch {
      // fall through
    }

    if (rgOutput) {
      const seen = new Set<string>()
      for (const line of rgOutput.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string } } }
          if (parsed.type === 'match' && parsed.data?.path?.text) {
            const filePath = parsed.data.path.text
            if (!seen.has(filePath)) {
              seen.add(filePath)
              const snippet = parsed.data.lines?.text?.trim() ?? ''
              evidence.push(`${filePath}: ${snippet}`.slice(0, 120))
              const relPath = filePath.replace(repoRoot + '/', '')
              const node = this.db.query<NodeRow, [number, string]>(
                `SELECT key, path, label FROM nodes WHERE run_id=? AND path=? AND kind='unit' LIMIT 1`
              ).get(this.runId, relPath)
              if (node && !nodeKeys.includes(node.key)) {
                nodeKeys.push(node.key)
              }
            }
          }
        } catch {
          // skip
        }
      }
    }

    // CLI entry point files
    const cliFiles = this.db.query<NodeRow, [number, string, string, string, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND (
         path = ? OR path = ? OR path = ? OR path = ?
       ) LIMIT 10`
    ).all(this.runId, 'src/index.ts', 'src/cli.ts', 'src/main.ts', 'index.ts')

    for (const n of cliFiles) {
      evidence.push(`file: ${n.path ?? n.label}`)
      if (!nodeKeys.includes(n.key)) {
        nodeKeys.push(n.key)
      }
    }

    // CLI-related symbols
    const cliSymbols = this.db.query<SymbolRow, [number, string, string, string, string]>(
      `SELECT s.name, s.kind, n.key as node_key, n.path as node_path
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id=? AND (
         s.name LIKE ? OR s.name LIKE ? OR s.name LIKE ? OR s.name = ?
       ) LIMIT 20`
    ).all(this.runId, '%command%', '%Command%', '%cmd%', 'main')

    for (const sym of cliSymbols) {
      evidence.push(`symbol: ${sym.name} (${sym.kind}) in ${sym.node_path ?? sym.node_key}`)
      if (!nodeKeys.includes(sym.node_key)) {
        nodeKeys.push(sym.node_key)
      }
    }

    if (evidence.length > 0 || nodeKeys.length > 0) {
      // Try to group into per-command flows if we have multiple CLI files
      // For simplicity, emit one aggregate "cli-commands" flow
      flows.push({
        key: 'flow:cli-commands',
        label: 'cli-commands',
        kind: 'command',
        confidence: confidenceFromHits(evidence.length + nodeKeys.length),
        nodes: nodeKeys.slice(0, 10),
        evidence: evidence.slice(0, 10),
      })
    }

    // Also look for individual command files in commands/ dir
    const commandNodes = this.db.query<NodeRow, [number, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND path LIKE ? ORDER BY path LIMIT 20`
    ).all(this.runId, 'src/commands/%')

    if (commandNodes.length > 0) {
      // If we already have cli-commands flow, just add nodes to it
      const existing = flows.find(f => f.key === 'flow:cli-commands')
      if (existing) {
        for (const n of commandNodes) {
          if (!existing.nodes.includes(n.key)) {
            existing.nodes.push(n.key)
          }
          existing.evidence.push(`command file: ${n.path ?? n.label}`)
        }
        existing.nodes = existing.nodes.slice(0, 10)
        existing.evidence = existing.evidence.slice(0, 10)
        existing.confidence = confidenceFromHits(existing.evidence.length + existing.nodes.length)
      } else {
        const cmdEvidence = commandNodes.map(n => `command file: ${n.path ?? n.label}`)
        flows.push({
          key: 'flow:cli-commands',
          label: 'cli-commands',
          kind: 'command',
          confidence: confidenceFromHits(commandNodes.length),
          nodes: commandNodes.map(n => n.key).slice(0, 10),
          evidence: cmdEvidence.slice(0, 10),
        })
      }
    }

    // Suppress unused variable warning
    void slugify

    return flows
  }
}
