> **Umbrella guidance:** the workspace-root `AGENTS.md` is the source of truth for cross-repo thesis, boundaries, and rules. This file is the repo-specific authority for `kin-editor`.

# kin-editor

VS Code extension for Kin (~3K production LOC). Provides entity explorer,
semantic search, trace, rename/review providers, and status bar — all
powered by the Kin daemon via MCP and the local HTTP API.

## Build

```bash
npm install
npm run compile        # TypeScript → JS
npm run package:vsix   # build .vsix for local install
npm test               # jest suite
```

## Architecture

- `src/extension.ts` — activation entry point
- `src/providers/` — VS Code language/tree providers (rename, hover, trace)
- `src/views/` — entity explorer tree views
- `src/mcp.ts` — MCP client bridge to the Kin daemon

The extension is a lightweight consumer of the Kin graph engine. No graph
logic lives here; all semantic work is delegated to the daemon.

## Boundary rule

Put work here when the job is VS Code UX, provider wiring, or MCP client
calls. Graph retrieval, indexing, and session state belong in `kin` and
`kin-db`. Do not add demo-only hardcoded state — surface real daemon data.
