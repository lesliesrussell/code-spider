# MCP Server

Bead: code-spider-o7o, code-spider-tnf

`code-spider mcp` runs a long-lived MCP stdio server over the repo-local
index: agents query the knowledge graph directly instead of paying a CLI
spawn per question. Tools mirror the read commands: `overview`, `zones`,
`show`, `children`, `related`, `flows`, `find`, `refs`, `defs`, `atoms`,
`intelligence_scan`, `doctor`. `refs`/`defs` accept `indexedOnly` for
millisecond answers from `symbol_edges` instead of live LSP.

## Install

```bash
code-spider mcp install
```

Writes (or merge-preserves) a project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "code-spider": {
      "command": "code-spider",
      "args": ["mcp"]
    }
  }
}
```

Claude Code picks this file up automatically. Commit it to share the server
with everyone who clones the repo — there is deliberately no `--repo` in the
args: the server resolves the repo from its launch directory, so the same
file works in every clone.

Other clients:

- **Claude Code, user scope** (all projects):
  `claude mcp add --scope user code-spider -- code-spider mcp`
- **Claude Desktop / Cursor**: add the same `command`/`args` pair to their
  MCP server settings.

## Prerequisites

The server answers from the index at `.code-spider/index.db`; build it first:

```bash
code-spider index . --semantic --embed
```

Without an index every tool returns the same "No index found" error the CLI
prints. `find` additionally needs the `--embed` pass (ollama +
nomic-embed-text; see `code-spider doctor`).

## Behavior notes

- Tools run the CLI command modules in-process; a command's user-input error
  (CLI exit 1) surfaces as an MCP tool error and the server keeps running.
- stdout is the MCP transport; server logs go to stderr.
- Reads follow capability-resolved run selection (see
  `run-lifecycle-design.md`): if the latest run lacks symbols or embeddings,
  tools fall back to the newest run that has them and say so.
