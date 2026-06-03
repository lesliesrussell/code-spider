import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// code-spider-c6v
import { buildIgnoreRules } from '../adapters/filesystem'
// code-spider-bik
import { debugLog } from '../utils/debug'

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

// code-spider-dvb
// Output caps: keep flows readable and queries bounded.
const MAX_FLOW_NODES = 10
const MAX_FLOW_EVIDENCE = 10
const MAX_FLOWS = 20
const EVIDENCE_SNIPPET_LEN = 120

// code-spider-9ld
// A flow is only emitted when at least one STRONG signal corroborates it.
// Strong signals are high-precision: real API call patterns (ripgrep), a
// matching dependency in package.json, or a file-naming convention. Symbol-name
// substring matches are WEAK — they may enrich an already-corroborated flow but
// can never justify emitting one on their own. Confidence is derived from the
// number of distinct strong signal categories, not from raw keyword hit counts.
function confidenceFromStrong(strongSignals: number): number {
  if (strongSignals >= 3) return 0.9
  if (strongSignals === 2) return 0.7
  if (strongSignals === 1) return 0.5
  return 0
}

// code-spider-9ld
class FlowBuilder {
  readonly nodeKeys: string[] = []
  readonly evidence: string[] = []
  private readonly seenNodes = new Set<string>()
  private strongSignals = 0

  addStrongSignal(): void {
    this.strongSignals++
  }

  addNode(key: string): void {
    if (!this.seenNodes.has(key)) {
      this.seenNodes.add(key)
      this.nodeKeys.push(key)
    }
  }

  addEvidence(item: string): void {
    this.evidence.push(item)
  }

  build(key: string, label: string, kind: string): Flow | null {
    if (this.strongSignals === 0) return null
    return {
      key,
      label,
      kind,
      confidence: confidenceFromStrong(this.strongSignals),
      // code-spider-dvb
      nodes: this.nodeKeys.slice(0, MAX_FLOW_NODES),
      evidence: this.evidence.slice(0, MAX_FLOW_EVIDENCE),
    }
  }
}

// code-spider-dvb
// Parsed once per detect() run — detectors share this instead of each
// re-reading package.json.
interface PackageInfo {
  deps: Set<string>
  fields: Set<string>
}

// code-spider-dvb
function loadPackageInfo(repoRoot: string): PackageInfo {
  try {
    const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as Record<string, unknown>
    const deps = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const section = pkg[field]
      if (section && typeof section === 'object') {
        for (const name of Object.keys(section as Record<string, unknown>)) {
          deps.add(name.toLowerCase())
        }
      }
    }
    return { deps, fields: new Set(Object.keys(pkg)) }
  } catch (err) {
    // code-spider-bik
    debugLog('flow-detector', 'failed to read package.json', err)
    return { deps: new Set(), fields: new Set() }
  }
}

interface RipgrepHit {
  path: string
  snippet: string
}

// code-spider-9ld
async function ripgrep(pattern: string, repoRoot: string): Promise<RipgrepHit[]> {
  try {
    // code-spider-c6v
    // Ignore dirs/globs come from defaults plus .code-spider/config.yaml so
    // self-referential folders and caches never feed flow detection.
    const rules = buildIgnoreRules(repoRoot)
    const ignoreGlobs: string[] = []
    for (const dir of rules.dirNames) {
      ignoreGlobs.push('--glob', `!**/${dir}/**`)
    }
    for (const glob of rules.globs) {
      ignoreGlobs.push('--glob', `!${glob}`)
    }
    // Exclude tests/fixtures: they routinely contain example route/event/queue
    // code as string fixtures, which is not the application's architecture.
    const proc = Bun.spawn(
      [
        'rg', '--json', '-i',
        ...ignoreGlobs,
        // code-spider-dvb
        ...testExclusionGlobs(),
        pattern, repoRoot,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const bytes = await new Response(proc.stdout).arrayBuffer()
    const output = new TextDecoder().decode(bytes)
    const hits: RipgrepHit[] = []
    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string } } }
        if (parsed.type === 'match' && parsed.data?.path?.text) {
          hits.push({
            path: parsed.data.path.text,
            snippet: parsed.data.lines?.text?.trim() ?? '',
          })
        }
      } catch (err) {
        // code-spider-bik
        debugLog('flow-detector', 'malformed rg JSON line', err)
        // skip malformed JSON lines
      }
    }
    return hits
  } catch (err) {
    // code-spider-bik
    debugLog('flow-detector', `rg search failed for pattern ${pattern}`, err)
    // rg not available
    return []
  }
}

function intersects(deps: Set<string>, candidates: string[]): boolean {
  return candidates.some(name => deps.has(name))
}

// code-spider-dvb
// Single source for test/fixture exclusion — both the SQL LIKE clauses and
// the rg globs derive from these so the two filters cannot drift apart.
const TEST_FILE_MARKERS = ['.test.', '.spec.']
const TEST_DIR_NAMES = ['test', 'tests', '__tests__', 'fixtures']

// code-spider-dvb
function testExclusionGlobs(): string[] {
  const globs: string[] = []
  for (const marker of TEST_FILE_MARKERS) {
    globs.push('--glob', `!*${marker}*`)
  }
  for (const dir of TEST_DIR_NAMES) {
    globs.push('--glob', `!**/${dir}/**`)
  }
  return globs
}

// code-spider-9ld
// Excludes test, spec, and fixture paths from node/symbol queries — example
// code in tests is not the application's real architecture.
function nonTestPath(col = 'path'): string {
  // code-spider-dvb
  const clauses: string[] = []
  for (const marker of TEST_FILE_MARKERS) {
    clauses.push(`AND ${col} NOT LIKE '%${marker}%'`)
  }
  for (const dir of TEST_DIR_NAMES) {
    clauses.push(`AND ${col} NOT LIKE '${dir}/%'`)
    clauses.push(`AND ${col} NOT LIKE '%/${dir}/%'`)
  }
  return `\n  ${clauses.join('\n  ')}`
}

const ROUTE_FRAMEWORKS = ['express', 'fastify', 'hono', 'koa', '@hapi/hapi', '@nestjs/core', 'next', '@sveltejs/kit', '@remix-run/node', 'restify', 'polka']
const QUEUE_LIBS = ['bullmq', 'bull', 'bee-queue', 'amqplib', 'amqp-connection-manager', 'kafkajs', 'agenda', 'kue', 'rsmq', '@aws-sdk/client-sqs', 'sqs-consumer']
const EVENT_LIBS = ['eventemitter3', 'eventemitter2', 'mitt', 'nanoevents', 'rxjs']

export class FlowDetector {
  constructor(private db: Database, private runId: number) {}

  async detect(repoRoot: string, nodeRef?: string): Promise<Flow[]> {
    const flows: Flow[] = []

    // code-spider-dvb
    const pkg = loadPackageInfo(repoRoot)
    const routeFlow = await this.detectRoutes(repoRoot, pkg)
    const eventFlows = await this.detectEvents(repoRoot, pkg)
    const cliFlow = await this.detectCli(repoRoot, pkg)

    for (const flow of [routeFlow, ...eventFlows, cliFlow]) {
      if (flow !== null) flows.push(flow)
    }

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

    // code-spider-dvb
    return filtered.slice(0, MAX_FLOWS)
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

  // Resolve a ripgrep absolute path to a unit node key.
  private nodeKeyForPath(repoRoot: string, absPath: string): string | null {
    const relPath = absPath.replace(repoRoot + '/', '')
    const node = this.db.query<NodeRow, [number, string]>(
      `SELECT key, path, label FROM nodes WHERE run_id=? AND path=? AND kind='unit' LIMIT 1`
    ).get(this.runId, relPath)
    return node?.key ?? null
  }

  // code-spider-9ld
  private async detectRoutes(repoRoot: string, pkg: PackageInfo): Promise<Flow | null> {
    const builder = new FlowBuilder()
    // code-spider-dvb
    const deps = pkg.deps

    // STRONG: a real web framework dependency.
    if (intersects(deps, ROUTE_FRAMEWORKS)) {
      builder.addStrongSignal()
      builder.addEvidence(`dependency: web framework (${ROUTE_FRAMEWORKS.find(f => deps.has(f))})`)
    }

    // STRONG: actual route-registration call sites.
    const routeHits = await ripgrep('(router|app|fastify|server)\\.(get|post|put|delete|patch)\\(', repoRoot)
    if (routeHits.length > 0) {
      builder.addStrongSignal()
      for (const hit of routeHits) {
        builder.addEvidence(`${hit.path}: ${hit.snippet}`.slice(0, EVIDENCE_SNIPPET_LEN))
        const key = this.nodeKeyForPath(repoRoot, hit.path)
        if (key) builder.addNode(key)
      }
    }

    // STRONG: file-based routing conventions.
    const routeFileNodes = this.db.query<NodeRow, [number, string, string, string, string, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND (
         path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ?
       )${nonTestPath()} LIMIT 20`
    ).all(this.runId, '%/route.ts', '%/routes.ts', '%/route.tsx', '%/page.tsx', '%/routes.js')
    if (routeFileNodes.length > 0) {
      builder.addStrongSignal()
      for (const n of routeFileNodes) {
        builder.addEvidence(`file: ${n.path ?? n.label}`)
        builder.addNode(n.key)
      }
    }

    // WEAK: symbol names that merely contain route-ish words. Only enrich an
    // already-corroborated flow; never trigger one alone.
    const routeSymbols = this.db.query<SymbolRow, [number, string, string, string, string]>(
      `SELECT s.name, s.kind, n.key as node_key, n.path as node_path
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id=? AND s.kind IN ('Class','Interface','Function','Method')
         AND (s.name LIKE ? OR s.name LIKE ? OR s.name LIKE ? OR s.name LIKE ?)
         ${nonTestPath('n.path')}
       LIMIT 50`
    ).all(this.runId, '%route%', '%handler%', '%controller%', '%endpoint%')
    for (const sym of routeSymbols) {
      builder.addEvidence(`symbol: ${sym.name} (${sym.kind}) in ${sym.node_path ?? sym.node_key}`)
      builder.addNode(sym.node_key)
    }

    return builder.build('flow:http-routes', 'http-routes', 'request')
  }

  // code-spider-9ld
  private async detectEvents(repoRoot: string, pkg: PackageInfo): Promise<Flow[]> {
    const flows: Flow[] = []
    // code-spider-dvb
    const deps = pkg.deps

    const queue = await this.detectQueueWorkers(repoRoot, deps)
    if (queue !== null) flows.push(queue)

    const events = await this.detectEventBus(repoRoot, deps)
    if (events !== null) flows.push(events)

    return flows
  }

  // code-spider-9ld
  private async detectQueueWorkers(repoRoot: string, deps: Set<string>): Promise<Flow | null> {
    const builder = new FlowBuilder()

    // STRONG: a dedicated queue/job library.
    if (intersects(deps, QUEUE_LIBS)) {
      builder.addStrongSignal()
      builder.addEvidence(`dependency: queue/job library (${QUEUE_LIBS.find(l => deps.has(l))})`)
    }

    // STRONG: explicit queue/worker construction.
    const ctorHits = await ripgrep('new\\s+(Worker|Queue|Consumer|Producer)\\(', repoRoot)
    if (ctorHits.length > 0) {
      builder.addStrongSignal()
      for (const hit of ctorHits) {
        builder.addEvidence(`${hit.path}: ${hit.snippet}`.slice(0, EVIDENCE_SNIPPET_LEN))
        const key = this.nodeKeyForPath(repoRoot, hit.path)
        if (key) builder.addNode(key)
      }
    }

    // STRONG: worker file convention (not generic "consumer"/"producer", which
    // are overloaded — e.g. React context consumers or test fixtures).
    const workerFiles = this.db.query<NodeRow, [number, string, string, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND (path LIKE ? OR path LIKE ? OR path LIKE ?)${nonTestPath()}
       LIMIT 10`
    ).all(this.runId, '%.worker.ts', '%/worker.ts', '%/worker.js')
    if (workerFiles.length > 0) {
      builder.addStrongSignal()
      for (const n of workerFiles) {
        builder.addEvidence(`file: ${n.path ?? n.label}`)
        builder.addNode(n.key)
      }
    }

    return builder.build('flow:queue-workers', 'queue-workers', 'worker')
  }

  // code-spider-9ld
  private async detectEventBus(repoRoot: string, deps: Set<string>): Promise<Flow | null> {
    const builder = new FlowBuilder()

    // STRONG: a pub/sub or event-emitter library.
    if (intersects(deps, EVENT_LIBS)) {
      builder.addStrongSignal()
      builder.addEvidence(`dependency: event library (${EVENT_LIBS.find(l => deps.has(l))})`)
    }

    // STRONG: constructing or extending an EventEmitter. Bare `.on(` / `.emit(`
    // are too common (child-process streams, DOM, sockets) to count as evidence
    // of an application-level event bus.
    const emitterHits = await ripgrep('(new\\s+EventEmitter|extends\\s+EventEmitter)', repoRoot)
    if (emitterHits.length > 0) {
      builder.addStrongSignal()
      for (const hit of emitterHits) {
        builder.addEvidence(`${hit.path}: ${hit.snippet}`.slice(0, EVIDENCE_SNIPPET_LEN))
        const key = this.nodeKeyForPath(repoRoot, hit.path)
        if (key) builder.addNode(key)
      }
    }

    return builder.build('flow:event-bus', 'event-bus', 'event')
  }

  // code-spider-9ld
  private async detectCli(repoRoot: string, pkg: PackageInfo): Promise<Flow | null> {
    const builder = new FlowBuilder()

    // STRONG: argument-parsing call sites.
    const argvHits = await ripgrep('process\\.argv|parseArgs|commander|yargs', repoRoot)
    if (argvHits.length > 0) {
      builder.addStrongSignal()
      const seen = new Set<string>()
      for (const hit of argvHits) {
        if (seen.has(hit.path)) continue
        seen.add(hit.path)
        builder.addEvidence(`${hit.path}: ${hit.snippet}`.slice(0, EVIDENCE_SNIPPET_LEN))
        const key = this.nodeKeyForPath(repoRoot, hit.path)
        if (key) builder.addNode(key)
      }
    }

    // STRONG: a declared CLI binary.
    // code-spider-dvb
    if (pkg.fields.has('bin')) {
      builder.addStrongSignal()
      builder.addEvidence('package.json: bin entry')
    }

    // STRONG: a command-per-file directory convention.
    const commandNodes = this.db.query<NodeRow, [number, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND path LIKE ?${nonTestPath()} ORDER BY path LIMIT 20`
    ).all(this.runId, 'src/commands/%')
    if (commandNodes.length > 0) {
      builder.addStrongSignal()
      for (const n of commandNodes) {
        builder.addEvidence(`command file: ${n.path ?? n.label}`)
        builder.addNode(n.key)
      }
    }

    // CLI entry-point files corroborate but are too generic to stand alone.
    const cliFiles = this.db.query<NodeRow, [number, string, string, string, string]>(
      `SELECT key, path, label FROM nodes
       WHERE run_id=? AND kind='unit' AND (path = ? OR path = ? OR path = ? OR path = ?)
       LIMIT 10`
    ).all(this.runId, 'src/index.ts', 'src/cli.ts', 'src/main.ts', 'index.ts')
    for (const n of cliFiles) {
      builder.addEvidence(`file: ${n.path ?? n.label}`)
      builder.addNode(n.key)
    }

    return builder.build('flow:cli-commands', 'cli-commands', 'command')
  }
}
