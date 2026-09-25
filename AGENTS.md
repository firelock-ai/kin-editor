# kin-editor

The VS Code extension for Kin. It provides the entity explorer, semantic search, trace, rename
and review providers, and the status bar. Every one of those reads the Kin daemon over a
persistent stdio MCP connection, with the `kin` CLI as the fallback transport. There is no HTTP
client here.

## Build and test

```bash
npm ci
npm run compile          # tsc -p ./tsconfig.build.json
npm run lint             # eslint src
npm test -- --runInBand  # jest
npm run package:vsix     # build a .vsix for a local install
```

## Layout

- `src/extension.ts` is the activation entry point and registers the commands.
- `src/providers/` holds the VS Code language providers for hover, definition, symbols, rename
  and review.
- `src/entity-explorer.ts` is the entity explorer's tree data provider.
- `src/kin-client.ts` is the query surface, MCP first with the CLI as fallback.
- `src/mcp-client.ts` is the stdio JSON-RPC bridge to `kin mcp start`.
- `src/__tests__/` holds the jest suites.

## Boundary rule

The extension consumes the Kin graph and holds no graph logic of its own. Put work here when the
job is VS Code UX, provider wiring or MCP client calls. Graph retrieval, indexing and session
state belong in `kin`. Surface real daemon data, and never add hardcoded demo-only state.

Sign off every commit with `git commit -s`.
