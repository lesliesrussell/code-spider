// code-spider-0fy
// Explicit entrypoints from .code-spider/config.yaml. Reachability,
// inference (code-spider-hma), and architecture rules all key off the
// entrypoint flag stamped into unit node metadata at index time.
// v1 is explicit-only; framework inference layers on later with lower
// confidence. See docs/intelligence-suite-design.md.
import { loadUserConfigSection } from '../adapters/filesystem'

export function loadEntrypointGlobs(repoRoot: string): string[] {
  return loadUserConfigSection(repoRoot, 'intelligence')['entrypoints'] ?? []
}

export function isEntrypoint(globs: string[], relPath: string): boolean {
  return globs.some(glob => new Bun.Glob(glob).match(relPath))
}
