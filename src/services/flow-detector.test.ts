import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { FlowDetector } from './flow-detector'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface SeedFile {
  path: string
  content: string
}

interface SeedSymbol {
  nodePath: string
  name: string
  kind: string
}

function makeRepo(name: string, files: SeedFile[], symbols: SeedSymbol[]): { repoRoot: string; db: ReturnType<typeof openDb> } {
  const repoRoot = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(repoRoot)

  for (const file of files) {
    const full = join(repoRoot, file.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, file.content)
  }

  const db = openDb(join(repoRoot, 'index.db'))
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, tool_version) VALUES (1,?,?,?,?)'
  ).run('2026-06-02T12:00:00Z', '2026-06-02T12:01:00Z', repoRoot, 'test')

  const unitPaths = [...new Set(files.map(f => f.path).concat(symbols.map(s => s.nodePath)))]
  const nodeIdByPath = new Map<string, number>()
  let nodeId = 1
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (?,1,'unit',?,?,?,'TypeScript',0.5,1)`
  )
  for (const path of unitPaths) {
    // code-spider-w8a
    insertNode.run(nodeId, `unit:${path}`, path.split('/').pop() ?? path, path)
    nodeIdByPath.set(path, nodeId)
    nodeId++
  }

  let symbolId = 1
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json)
     VALUES (?,1,?,?,?,?,null,null,null,null,null)`
  )
  for (const sym of symbols) {
    const nid = nodeIdByPath.get(sym.nodePath)
    if (nid === undefined) continue
    insertSymbol.run(symbolId, nid, `${sym.nodePath}:${sym.name}`, sym.name, sym.kind)
    symbolId++
  }

  return { repoRoot, db }
}

function labels(flows: { label: string }[]): string[] {
  return flows.map(f => f.label)
}

describe('FlowDetector', () => {
  // code-spider-a6t
  test('config flows: patterns extend detection to non-Node ecosystems', async () => {
    const { repoRoot, db } = makeRepo(
      'flow-config',
      [
        // A Python web app: no package.json, builtin Node heuristics see nothing.
        { path: 'src/app.py', content: 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/users")\ndef users():\n    return []\n' },
        { path: '.code-spider/config.yaml', content: 'flows:\n  route_patterns:\n    - "@app\\.route\\("\n' },
      ],
      [],
    )

    const flows = await new FlowDetector(db, 1).detect(repoRoot)
    const routes = flows.find(flow => flow.label === 'http-routes')
    expect(routes).toBeDefined()
    // One user-pattern category = one strong signal = floor confidence.
    expect(routes!.confidence).toBe(0.5)
    expect(routes!.evidence.some(item => item.startsWith('config-pattern:') && item.includes('src/app.py'))).toBe(true)
    expect(routes!.nodes).toContain('unit:src/app.py')
  })

  // code-spider-a6t
  test('config flows: patterns never fire without matches (no fabrication)', async () => {
    const { repoRoot, db } = makeRepo(
      'flow-config-negative',
      [
        { path: 'src/app.py', content: 'print("hello")\n' },
        { path: '.code-spider/config.yaml', content: 'flows:\n  route_patterns:\n    - "@app\\.route\\("\n  queue_patterns:\n    - "celery\\.task"\n' },
      ],
      [],
    )

    const flows = await new FlowDetector(db, 1).detect(repoRoot)
    expect(labels(flows)).not.toContain('http-routes')
    expect(labels(flows)).not.toContain('queue-workers')
  })

  // code-spider-9ld
  test('does NOT fabricate http/queue/event flows from name-substring noise alone', async () => {
    // Mimics the code-spider repo: a CLI tool with a local `queue` variable,
    // an `event`-named symbol, and LSP-style `.on()` usage — but no real
    // HTTP routes, message queue, or event bus.
    const { repoRoot, db } = makeRepo(
      'flow-negative',
      [
        { path: 'package.json', content: JSON.stringify({ name: 'x', bin: { x: 'src/index.ts' } }) },
        { path: 'src/index.ts', content: 'const argv = process.argv.slice(2)\nconst queue = []\nchild.on("data", () => {})\n' },
        { path: 'src/commands/foo.ts', content: 'export default function run() {}\n' },
        { path: 'src/services/doctor.ts', content: 'const queue = [""]\n' },
      ],
      [
        { nodePath: 'src/services/doctor.ts', name: 'queue', kind: 'Variable' },
        { nodePath: 'src/index.ts', name: 'handleEvent', kind: 'Function' },
      ],
    )

    const flows = await new FlowDetector(db, 1).detect(repoRoot)
    const found = labels(flows)

    expect(found).not.toContain('http-routes')
    expect(found).not.toContain('queue-workers')
    expect(found).not.toContain('event-bus')
  })

  // code-spider-9ld
  test('still detects the real cli-commands flow for a CLI tool', async () => {
    const { repoRoot, db } = makeRepo(
      'flow-cli',
      [
        { path: 'package.json', content: JSON.stringify({ name: 'x', bin: { x: 'src/index.ts' } }) },
        { path: 'src/index.ts', content: 'const argv = process.argv.slice(2)\n' },
        { path: 'src/commands/foo.ts', content: 'export default function run() {}\n' },
        { path: 'src/commands/bar.ts', content: 'export default function run() {}\n' },
      ],
      [],
    )

    const flows = await new FlowDetector(db, 1).detect(repoRoot)
    const cli = flows.find(f => f.label === 'cli-commands')
    expect(cli).toBeDefined()
    expect(cli?.confidence ?? 0).toBeGreaterThanOrEqual(0.5)
  })

  // code-spider-9ld
  test('detects http-routes when a real web framework + route calls exist', async () => {
    const { repoRoot, db } = makeRepo(
      'flow-routes',
      [
        { path: 'package.json', content: JSON.stringify({ name: 'x', dependencies: { express: '^4' } }) },
        { path: 'src/server.ts', content: 'const app = express()\napp.get("/users", handler)\napp.post("/users", handler)\n' },
      ],
      [],
    )

    const flows = await new FlowDetector(db, 1).detect(repoRoot)
    const routes = flows.find(f => f.label === 'http-routes')
    expect(routes).toBeDefined()
    expect(routes?.confidence ?? 0).toBeGreaterThanOrEqual(0.5)
  })

  // code-spider-9ld
  test('detects event-bus only with a real EventEmitter, not "event"-named symbols', async () => {
    const { repoRoot, db } = makeRepo(
      'flow-events',
      [
        { path: 'package.json', content: JSON.stringify({ name: 'x', dependencies: { eventemitter3: '^5' } }) },
        { path: 'src/bus.ts', content: 'import EventEmitter from "eventemitter3"\nexport const bus = new EventEmitter()\n' },
      ],
      [],
    )

    const flows = await new FlowDetector(db, 1).detect(repoRoot)
    expect(labels(flows)).toContain('event-bus')
  })
})
