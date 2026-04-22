import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { openDb } from '../db/init'
import { Exporter } from './exporter'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

function makeTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-db-`))
  tempDirs.push(dir)
  return join(dir, 'index.db')
}

function initGitRepo(repoRoot: string): void {
  execSync('git init', { cwd: repoRoot, stdio: 'ignore' })
  execSync('git config user.name "Test User"', { cwd: repoRoot, stdio: 'ignore' })
  execSync('git config user.email "test@example.com"', { cwd: repoRoot, stdio: 'ignore' })
}

describe('Exporter freshness metadata', () => {
  test('includes freshness metadata in node json output', async () => {
    const repoRoot = makeTempRepo('code-spider-exporter-json')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'main.ts'), 'export const answer = 42\n')
    initGitRepo(repoRoot)

    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' })
    const dbPath = makeTempDbPath('code-spider-exporter-json')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', 'Top-level file', 0.8, 1)`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 20),
         (1, 1, 'churn', 3),
         (1, 1, 'recency', 2)`
    ).run()
    db.query(
      `INSERT INTO analyzers (id, run_id, language, tool_name, tool_kind, available, metadata_json)
       VALUES (1, 1, 'typescript', 'typescript-language-server', 'lsp', 1, '{}')`
    ).run()
    db.query(
      `INSERT INTO analyzer_runs (
         run_id, analyzer_id, node_id, language, capability, status, target, duration_ms, error_message, metadata_json
       ) VALUES
         (1, 1, 1, 'typescript', 'symbols', 'success', 'src/main.ts', 12, null, '{}')`
    ).run()

    const output = await new Exporter(db, 1).exportNode('unit:src/main.ts', 'json')
    const payload = JSON.parse(output) as {
      freshness: {
        runId: number
        indexTimestamp: string
        semanticTimestamp: string | null
        dirtyWorktree: boolean | null
      }
      provenance: {
        summary: string
        evidence: string
        symbols: string
        children: string
      }
    }

    expect(payload.freshness).toEqual({
      runId: 1,
      indexTimestamp: '2026-04-22T10:00:00Z',
      semanticTimestamp: '2026-04-22T10:02:00Z',
      repoCommit: 'abc1234',
      dirtyWorktree: false,
    })
    expect(payload.provenance).toEqual({
      summary: 'inferred',
      evidence: 'observed',
      symbols: 'observed',
      children: 'observed',
    })
  })

  test('includes freshness metadata in markdown output and reports dirty worktree', async () => {
    const repoRoot = makeTempRepo('code-spider-exporter-md')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'main.ts'), 'export const answer = 42\n')
    initGitRepo(repoRoot)
    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' })
    writeFileSync(join(repoRoot, 'src', 'main.ts'), 'export const answer = 43\n')

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', 'Top-level file', 0.8, 1)`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 20),
         (1, 1, 'churn', 3),
         (1, 1, 'recency', 2)`
    ).run()

    const output = await new Exporter(db, 1).exportNode('unit:src/main.ts', 'md')

    expect(output).toContain('**Freshness:** index 2026-04-22T10:00:00Z')
    expect(output).toContain('**Semantic:** not available')
    expect(output).toContain('**Worktree:** dirty')
  })

  test('distinguishes inferred summary from observed facts in markdown output', async () => {
    const repoRoot = makeTempRepo('code-spider-exporter-provenance')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'main.ts'), 'export const answer = 42\n')
    initGitRepo(repoRoot)
    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' })

    const dbPath = makeTempDbPath('code-spider-exporter-provenance')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence)
       VALUES
         (1, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', 'Likely top-level entrypoint', 0.8, 1),
         (2, 1, 'unit', 'unit:src/child.ts', 'child.ts', 'src/child.ts', 'TypeScript', null, 0.4, 1)`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 20),
         (1, 1, 'churn', 3),
         (1, 1, 'recency', 2)`
    ).run()
    db.query(
      `INSERT INTO evidence (run_id, node_id, kind, source, locator, snippet, score)
       VALUES (1, 1, 'git', 'abc1234', 'src/main.ts', 'initial commit', 1.0)`
    ).run()
    db.query(
      `INSERT INTO symbols (run_id, node_id, symbol_key, name, kind)
       VALUES (1, 1, 'src/main.ts:answer', 'answer', 'Constant')`
    ).run()

    const output = await new Exporter(db, 1).exportNode('unit:src/main.ts', 'md')

    expect(output).toContain('## Inferred Summary')
    expect(output).toContain('Likely top-level entrypoint')
    expect(output).toContain('## Observed Facts')
    expect(output).toContain('### Evidence')
    expect(output).toContain('### Symbols')
  })

  test('adds risk signals and fallback guidance to markdown output', async () => {
    const repoRoot = makeTempRepo('code-spider-exporter-risk')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'core.ts'), 'export class ExampleService {}\nexport function execute() { return new ExampleService() }\n')
    initGitRepo(repoRoot)
    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' })

    const dbPath = makeTempDbPath('code-spider-exporter-risk')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/core.ts', 'core.ts', 'src/core.ts', 'TypeScript', 'Likely orchestration point', 0.9, 1)`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 40),
         (1, 1, 'churn', 7),
         (1, 1, 'recency', 1)`
    ).run()
    db.query(
      `INSERT INTO symbols (run_id, node_id, symbol_key, name, kind) VALUES
         (1, 1, 'src/core.ts:ExampleService', 'ExampleService', 'Class'),
         (1, 1, 'src/core.ts:execute', 'execute', 'Function')`
    ).run()
    db.query(
      `INSERT INTO analyzers (id, run_id, language, tool_name, tool_kind, available, metadata_json)
       VALUES (1, 1, 'typescript', 'typescript-language-server', 'lsp', 1, '{}')`
    ).run()
    db.query(
      `INSERT INTO diagnostics (run_id, node_id, analyzer_id, severity, message)
       VALUES (1, 1, 1, 'warning', 'something to watch')`
    ).run()
    db.query(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight)
       VALUES
         (1, 1, 1, 'mentions', 1),
         (1, 1, 1, 'contains', 1),
         (1, 1, 1, 'related', 1),
         (1, 1, 1, 'related', 1),
         (1, 1, 1, 'related', 1)`
    ).run()

    const output = await new Exporter(db, 1).exportNode('unit:src/core.ts', 'md')

    expect(output).toContain('## Risk')
    expect(output).toContain('Level: high')
    expect(output).toContain('high hotspot score (0.90)')
    expect(output).toContain('recently high churn (7)')
    expect(output).toContain('1 diagnostics recorded')
    expect(output).toContain('## Guidance')
    expect(output).toContain('no flow edges detected; use fallback queries for behavioral tracing:')
    expect(output).toContain('code-spider refs ExampleService')
    expect(output).toContain('code-spider refs execute')
  })

  test('adds a compiler phase-boundary line when multiple artifact stages are detected', async () => {
    const repoRoot = makeTempRepo('code-spider-exporter-phases')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'compiler.ts'), 'export const placeholder = 1\n')
    initGitRepo(repoRoot)
    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' })

    const dbPath = makeTempDbPath('code-spider-exporter-phases')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/compiler.ts', 'compiler.ts', 'src/compiler.ts', 'TypeScript', 'Compiler entrypoint', 0.6, 1)`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 50),
         (1, 1, 'churn', 2),
         (1, 1, 'recency', 3)`
    ).run()
    db.query(
      `INSERT INTO symbols (run_id, node_id, symbol_key, name, kind) VALUES
         (1, 1, 'src/compiler.ts:tokenize', 'tokenize', 'Function'),
         (1, 1, 'src/compiler.ts:AstNode', 'AstNode', 'Class'),
         (1, 1, 'src/compiler.ts:lowerToIr', 'lowerToIr', 'Function'),
         (1, 1, 'src/compiler.ts:emitBytecode', 'emitBytecode', 'Function')`
    ).run()

    const output = await new Exporter(db, 1).exportNode('unit:src/compiler.ts', 'md')
    const jsonOutput = await new Exporter(db, 1).exportNode('unit:src/compiler.ts', 'json')
    const jsonPayload = JSON.parse(jsonOutput) as { phaseBoundary: { artifacts: string[] } | null }

    expect(output).toContain('## Phase Boundaries')
    expect(output).toContain('Artifacts crossing phases: token stream -> AST nodes -> IR program -> bytecode')
    expect(jsonPayload.phaseBoundary).toEqual({
      artifacts: ['token stream', 'AST nodes', 'IR program', 'bytecode'],
    })
  })

  test('exports investigations with curated markdown, issue, and git context', async () => {
    const repoRoot = makeTempRepo('code-spider-exporter-investigation')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'main.ts'), 'export class Runner {}\n')
    initGitRepo(repoRoot)
    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: repoRoot, stdio: 'ignore' })

    const dbPath = makeTempDbPath('code-spider-exporter-investigation')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO investigations (id, run_id, title, question, status, summary, created_at, updated_at)
       VALUES (7, 1, 'Trace Runner', 'Why is Runner central?', 'open', 'Start with the entrypoint.', '2026-04-22T10:03:00Z', '2026-04-22T10:03:00Z')`
    ).run()
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence, metadata_json)
       VALUES
         (1, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', 'Top-level runner orchestration.', 0.9, 1, NULL),
         (2, 1, 'doc', 'doc:README.md', 'README.md', 'README.md', 'Markdown', 'Repository guide', 0, 0.8, NULL),
         (3, 1, 'doc_section', 'doc_section:README.md#overview', 'Overview', 'README.md', 'Markdown', 'Explains the runner role', 0, 0.8, NULL),
         (4, 1, 'issue', 'issue:code-spider-8jw', 'Integrate context nodes into investigations', 'code-spider-8jw', NULL, 'Tracks this feature', 0.9, 0.9, '{"status":"in_progress"}')`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 25),
         (1, 1, 'churn', 4),
         (1, 1, 'recency', 1)`
    ).run()
    db.query(
      `INSERT INTO investigation_nodes (investigation_id, node_id, note)
       VALUES (7, 1, 'Investigate the main control path')`
    ).run()
    db.query(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight) VALUES
         (1, 3, 1, 'mentions', 1),
         (1, 2, 3, 'contains', 1),
         (1, 4, 1, 'tracked-by', 2)`
    ).run()
    db.query(
      `INSERT INTO evidence (run_id, node_id, kind, source, locator, snippet, score)
       VALUES (1, 1, 'git', 'abc1234', 'src/main.ts', 'initial runner implementation', 1.0)`
    ).run()

    const md = await new Exporter(db, 1).exportInvestigation(7, 'md')
    const jsonOutput = await new Exporter(db, 1).exportInvestigation(7, 'json')
    const payload = JSON.parse(jsonOutput) as {
      nodes: Array<{
        markdownContext: Array<{ docLabel: string; sectionTitle: string }>
        beadsContext: Array<{ issueId: string | null; title: string }>
        gitContext: Array<{ source: string; snippet: string | null }>
      }>
    }

    expect(md).toContain('Context')
    expect(md).toContain('docs: README.md :: Overview (README.md)')
    expect(md).toContain('issue: code-spider-8jw [in_progress] Integrate context nodes into investigations')
    expect(md).toContain('git: abc1234 (src/main.ts) — initial runner implementation')
    expect(payload.nodes[0]?.markdownContext[0]?.docLabel).toBe('README.md')
    expect(payload.nodes[0]?.markdownContext[0]?.sectionTitle).toBe('Overview')
    expect(payload.nodes[0]?.beadsContext[0]?.issueId).toBe('code-spider-8jw')
    expect(payload.nodes[0]?.beadsContext[0]?.title).toBe('Integrate context nodes into investigations')
    expect(payload.nodes[0]?.gitContext[0]?.source).toBe('abc1234')
    expect(payload.nodes[0]?.gitContext[0]?.snippet).toBe('initial runner implementation')
  })
})
