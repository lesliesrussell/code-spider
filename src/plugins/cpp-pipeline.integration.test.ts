// code-spider-5u3
// End-to-end proof that a real clang-tidy run flows all the way to a
// correctness finding and SARIF. Skipped when clang-tidy is unavailable so
// the suite stays green on machines without the C/C++ toolchain.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commandExists } from '../utils/exec'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import { CppPlugin } from './cpp-plugin'
import { openDb } from '../db/init'
import { CAuditAnalyzer } from '../services/c-audit'
import { FindingsStore } from '../services/findings'
import { renderFindingsSarif } from '../services/findings-sarif'

const HAS_CLANG_TIDY = commandExists('clang-tidy')

const C_SOURCE = `#include <stdlib.h>

int deref(void) {
    int *p = NULL;
    return *p;
}

void leak(void) {
    int *q = (int *)malloc(sizeof(int) * 10);
    q[0] = 1;
}
`

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cpp-pipeline-'))
  tempDirs.push(dir)
  const file = join(dir, 'bug.c')
  writeFileSync(file, C_SOURCE)
  writeFileSync(
    join(dir, 'compile_commands.json'),
    JSON.stringify([{ directory: dir, command: `clang -c ${file}`, file }]),
  )
  return { dir, file }
}

// Persist plugin diagnostics into the diagnostics table the way
// semantic-enricher does (numeric LSP severity -> string).
const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

describe('C/C++ audit pipeline (integration)', () => {
  test.skipIf(!HAS_CLANG_TIDY)('real clang-tidy diagnostics become correctness findings and SARIF', async () => {
    const { dir, file } = fixtureRepo()

    // 1. Real clang-tidy run through the plugin (compile DB discovered -> -p).
    const plugin = new CppPlugin(loadDefaultAnalyzerRegistry(), commandExists)
    const diag = await plugin.getDiagnostics({ repoRoot: dir, filePath: file, languageId: 'c' })

    expect(diag.items.length).toBeGreaterThanOrEqual(2)
    const nullDeref = diag.items.find(d => d.code === 'clang-analyzer-core.NullDereference')
    expect(nullDeref).toBeDefined()
    expect(nullDeref?.severity).toBe(2)
    expect(diag.items.some(d => d.code === 'clang-analyzer-unix.Malloc')).toBe(true)

    // 2. Persist into the diagnostics table.
    const db = openDb(join(dir, 'index.db'))
    db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', ?)").run(dir)
    db.query("INSERT INTO nodes (id, run_id, kind, key, label, path) VALUES (1, 1, 'unit', 'unit:bug.c', 'bug.c', 'bug.c')").run()
    db.query("INSERT INTO analyzers (id, run_id, language, tool_name, tool_kind, available) VALUES (1, 1, 'c', 'clang-tidy', 'quality', 1)").run()
    const insert = db.prepare(
      "INSERT INTO diagnostics (run_id, node_id, analyzer_id, severity, code, message, range_json) VALUES (1, 1, 1, ?, ?, ?, ?)",
    )
    for (const d of diag.items) {
      insert.run(SEVERITY[d.severity] ?? 'warning', d.code ?? null, d.message, JSON.stringify(d.range))
    }

    // 3. Promote to correctness findings.
    new CAuditAnalyzer().analyze(db, 1)
    const findings = new FindingsStore(db, 1).list({ category: 'correctness' })
    expect(findings.length).toBeGreaterThanOrEqual(2)
    expect(findings.some(f => f.ruleId === 'clang-analyzer-core.NullDereference')).toBe(true)

    // 4. SARIF carries them.
    const sarif = renderFindingsSarif(findings)
    expect(sarif.version).toBe('2.1.0')
    expect(sarif.runs[0]?.results.some(r => r.ruleId === 'clang-analyzer-core.NullDereference')).toBe(true)
    db.close()
  })

  test('degrades to empty without throwing when no C/C++ tools are present', async () => {
    const { dir, file } = fixtureRepo()
    const plugin = new CppPlugin(loadDefaultAnalyzerRegistry(), () => false)
    const diag = await plugin.getDiagnostics({ repoRoot: dir, filePath: file, languageId: 'c' })
    expect(diag.items).toEqual([])
    expect(diag.error).toBeDefined()
  })
})
