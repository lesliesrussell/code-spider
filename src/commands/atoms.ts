import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { SemanticQueryService } from '../services/semantic-query'
// code-spider-ab9
import { recordIngestedNodes } from '../services/token-ledger'

export default async function run(ctx: CliContext): Promise<void> {
  const unitRef = ctx.args[0]
  if (!unitRef) {
    console.error('Usage: code-spider atoms <unit-ref>')
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  // code-spider-ag4
  const { runId, fallbackFrom } = Navigator.resolveSemanticRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }
  if (fallbackFrom !== null) {
    console.error(`Note: latest run #${fallbackFrom} has no semantic data; using run #${runId}. Refresh with: code-spider index --semantic`)
  }

  const nav = new Navigator(db, runId)
  const node = nav.getNode(unitRef)
  if (node === null || node.kind !== 'unit') {
    console.error(`Unit not found: ${unitRef}`)
    process.exit(1)
  }

  const atoms = new SemanticQueryService(db, runId).findAtoms(unitRef)
  // code-spider-ab9
  recordIngestedNodes(db, runId, [node.key])

  if (ctx.json) {
    console.log(JSON.stringify(atoms, null, 2))
    return
  }

  console.log(`Atoms in ${unitRef}`)
  console.log()

  if (atoms.length === 0) {
    console.log('  (no atoms)')
    return
  }

  for (const atom of atoms) {
    const line = atom.anchorLine !== null ? atom.anchorLine + 1 : '?'
    const column = atom.anchorColumn !== null ? atom.anchorColumn + 1 : '?'
    const container = atom.containerName ? `  in ${atom.containerName}` : ''
    const flags = [
      atom.heuristic ? '[heuristic]' : null,
      atom.lowSignal ? '[low-signal]' : null,
    ].filter(flag => flag !== null).join('  ')
    const suffix = flags ? `  ${flags}` : ''
    console.log(`  ${String(line).padStart(4)}:${String(column).padEnd(4)}  ${atom.kind.padEnd(12)}  ${atom.name}${container}${suffix}`)
  }
}
