# code-spider design docs

These documents were deleted in commit `5bf0c3d` ("cleaning up the trash") and
restored from `5bf0c3d^` under [code-spider-4v5]. They capture the original
intent and design history of the project.

> **Treat as history, not current truth.** Several were written before the
> language-plugin / analyzer-registry refactor and the context-layer rollout,
> so details may lag the current implementation in `src/`. When in doubt, the
> code and `bd` issues are authoritative.

| Doc | What it is |
|-----|------------|
| [code-spider-prd.md](code-spider-prd.md) | Top-level product requirements |
| [code-spider-prd-spec1.md](code-spider-prd-spec1.md) | PRD spec, part 1 |
| [code-spider-prd-spec2.md](code-spider-prd-spec2.md) | PRD spec, part 2 |
| [context-layer-design.md](context-layer-design.md) | Git / markdown / beads context enrichers |
| [language-plugin-design.md](language-plugin-design.md) | Language plugin + analyzer registry design |
| [analyzer-execution-plan.md](analyzer-execution-plan.md) | Analyzer execution pipeline plan |
| [starshiptroopers.md](starshiptroopers.md) | A code-spider fix/review plan (whimsical filename) |

Agent meta files (`AGENTS.md`, project `CLAUDE.md`) were restored to the repo
root, where agents load them. `nardo.yaml` was intentionally not restored.
