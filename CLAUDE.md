> **Umbrella guidance:** the workspace-root `AGENTS.md` is the source of truth for cross-repo thesis, boundaries, and rules. This file is the repo-specific authority for `kin-editor`.

# kin-editor

VS Code extension for Kin (~3K production LOC). Provides entity explorer,
semantic search, trace, rename/review providers, and status bar, all powered
by the Kin daemon over a persistent stdio MCP connection, with the `kin` CLI
as the fallback transport. There is no HTTP client here.

## Build

```bash
npm install
npm run compile        # TypeScript → JS
npm run package:vsix   # build .vsix for local install
npm test               # jest suite
```

## Architecture

- `src/extension.ts`: activation entry point and command registration
- `src/providers/`: VS Code language providers (hover, definition, symbol,
  rename, review)
- `src/entity-explorer.ts`: the entity explorer tree data provider
- `src/kin-client.ts`: query surface, MCP first and CLI fallback
- `src/mcp-client.ts`: stdio JSON-RPC bridge to `kin mcp start`

The extension is a lightweight consumer of the Kin graph engine. No graph
logic lives here; all semantic work is delegated to the daemon.

## Boundary rule

Put work here when the job is VS Code UX, provider wiring, or MCP client
calls. Graph retrieval, indexing, and session state belong in `kin` and
`kin-db`. Do not add demo-only hardcoded state. Surface real daemon data.
