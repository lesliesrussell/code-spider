// code-spider-ty9
// Manifest-aware reachability rules:
//   unused-dependency — declared in package.json, imported nowhere, not
//     referenced by any script. dependencies flag at medium confidence
//     (bin-only usage is invisible to import scanning), devDependencies at
//     low (CLI tools rarely get imported). @types/* never flags — tsc
//     consumes those without imports.
//   orphan-test — a co-located X.test.ts whose subject X.* no longer exists.
//     Convention-based: tested-by edges are not populated yet (same gap as
//     symbol_edges, see code-spider-8h8), and tests in dedicated test dirs
//     don't follow the sibling convention, so they are exempt.
// See docs/intelligence-suite-design.md.
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'
import { scanFileSpecifiers } from './import-edges'
import { debugLog } from '../utils/debug'

const TEST_DIR = /(^|\/)(test|tests|__tests__)\//
const TEST_SUFFIX = /\.(test|spec)\.(ts|tsx|js|jsx)$/
const SUBJECT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

// 'pkg/sub' -> 'pkg', '@scope/pkg/sub' -> '@scope/pkg'
function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

export class ManifestAnalyzer {
  async analyze(db: Database, runId: number): Promise<{ findings: number }> {
    const run = db.query('SELECT repo_root FROM runs WHERE id = ?').get(runId) as { repo_root: string } | null
    if (run === null) return { findings: 0 }

    const units = (
      db
        .query(`SELECT path FROM nodes WHERE run_id = ? AND kind = 'unit' AND path IS NOT NULL ORDER BY path`)
        .all(runId) as Array<{ path: string }>
    ).map(r => r.path)
    const unitSet = new Set(units)

    purgeFindings(db, runId, { ruleId: 'unused-dependency' })
    purgeFindings(db, runId, { ruleId: 'orphan-test' })
    const store = new FindingsStore(db, runId)
    let count = 0

    count += await this.unusedDependencies(run.repo_root, units, store)
    // code-spider-sgm
    // tested-by edges rescue: a test linked to any real unit is testing
    // something that exists, whatever its filename says.
    const testedByTargets = new Set(
      (
        db
          .query(
            `SELECT n2.path AS testPath FROM edges e
             JOIN nodes n2 ON e.to_node_id = n2.id
             WHERE e.run_id = ? AND e.kind = 'tested-by' AND n2.path IS NOT NULL`
          )
          .all(runId) as Array<{ testPath: string }>
      ).map(r => r.testPath)
    )
    count += this.orphanTests(units, unitSet, testedByTargets, store)
    return { findings: count }
  }

  private async unusedDependencies(repoRoot: string, units: string[], store: FindingsStore): Promise<number> {
    let pkg: PackageJson
    try {
      pkg = JSON.parse(await Bun.file(join(repoRoot, 'package.json')).text()) as PackageJson
    } catch (err) {
      // No manifest (or unparseable): nothing to check, not an error.
      debugLog('manifest', `no usable package.json at ${repoRoot}`, err)
      return 0
    }

    const imported = new Set<string>()
    for (const unit of units) {
      for (const imp of await scanFileSpecifiers(repoRoot, unit)) {
        if (imp.path.startsWith('.') || imp.path.startsWith('/')) continue
        if (imp.path.startsWith('bun:') || imp.path.startsWith('node:')) continue
        imported.add(packageName(imp.path))
      }
    }
    const scriptText = Object.values(pkg.scripts ?? {}).join('\n')

    let count = 0
    const declaredGroups: Array<{ deps: Record<string, string>; confidence: 'medium' | 'low'; group: string }> = [
      { deps: pkg.dependencies ?? {}, confidence: 'medium', group: 'dependencies' },
      { deps: pkg.devDependencies ?? {}, confidence: 'low', group: 'devDependencies' },
    ]
    for (const { deps, confidence, group } of declaredGroups) {
      for (const name of Object.keys(deps).sort()) {
        if (name.startsWith('@types/')) continue
        if (imported.has(name)) continue
        if (scriptText.includes(name)) continue
        store.add({
          ruleId: 'unused-dependency',
          category: 'reachability',
          severity: 'warning',
          confidence,
          title: `Unused dependency: ${name}`,
          summary: `${name} is declared in ${group} but never imported and not referenced by any package script`,
          anchor: `${group}:${name}`,
          locations: [{ path: 'package.json' }],
          tags: ['manifest'],
        })
        count++
      }
    }
    return count
  }

  private orphanTests(units: string[], unitSet: Set<string>, testedByTargets: Set<string>, store: FindingsStore): number {
    let count = 0
    for (const unit of units) {
      if (TEST_DIR.test(unit) || !TEST_SUFFIX.test(unit)) continue
      // code-spider-sgm: edge-backed rescue beats the filename convention
      if (testedByTargets.has(unit)) continue
      const base = unit.replace(TEST_SUFFIX, '')
      const subjectExists = SUBJECT_EXTENSIONS.some(ext => unitSet.has(`${base}${ext}`))
      if (subjectExists) continue
      store.add({
        ruleId: 'orphan-test',
        category: 'reachability',
        severity: 'warning',
        confidence: 'medium',
        title: `Orphan test: ${unit}`,
        summary: `${unit} has no co-located subject (${base}.*) — the file it tested may have been deleted or moved`,
        anchor: unit,
        nodeKey: `unit:${unit}`,
        locations: [{ path: unit }],
        tags: ['manifest'],
      })
      count++
    }
    return count
  }
}
