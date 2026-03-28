# Kin - Semantic VCS for VS Code

Semantic code intelligence powered by [Kin](https://github.com/firelock-ai/kin-editor)'s graph engine.

## Features

- **Entity Explorer** -- Browse functions, classes, modules, and other entities in a sidebar tree view grouped by kind.
- **Semantic Search** -- `Cmd+Shift+K S` to find entities by name with quick navigation to source.
- **Entity Trace** -- Right-click in the editor or `Cmd+Shift+K T` to trace an entity through the dependency graph.
- **Hover Info** -- Hover over any symbol to see its entity kind, file, and signature from the graph.
- **Go to Definition** -- `F12` / `Ctrl+Click` resolves definitions through the Kin graph.
- **Workspace Symbols** -- `Cmd+T` / `Ctrl+T` searches entities via the graph-backed symbol provider.
- **Semantic Review** -- `Cmd+Shift+K V` to run entity-level code review with gutter decorations and diagnostics.
- **Semantic Rename** -- `F2` on any entity for graph-aware rename across all references.
- **Status Bar** -- Live entity count and connection mode (MCP/CLI) in the bottom bar. Click for a graph overview.
- **Graph Overview** -- `Cmd+Shift+K O` to see entity counts, edge counts, and kind breakdowns at a glance.

## Accessibility

- Entity Explorer tree items include explicit kind, file, line, and signature context for screen readers.
- Search and trace quick-picks keep the entity name separate from the file location and kind details.
- Review gutter markers use theme-driven icons and colors so they stay legible in high-contrast themes.
- Command Palette entries are grouped under the `Kin` category for easier discovery.

## Requirements

- The `kin` CLI binary must be installed (`~/.kin/bin/kin` or on PATH).
- A Kin-initialized repository (`.kin/` directory in workspace root).

## Installation

1. Build the extension: `npm install && npm run compile`
2. Package: `npm run package:vsix`
3. Install the `.vsix` file in VS Code: Extensions > "..." > "Install from VSIX..."

Or for development: open this folder in VS Code and press F5 to launch the Extension Development Host.

## Compatibility

- VSIX install smoke verified on 2026-03-25 in VSCodium `1.112.01907`, Cursor `2.6.21`, and Windsurf `1.108.2`.
- Each editor listed the installed extension as `firelock.kin@0.1.0` from the packaged VSIX.
- Tagged GitHub releases now attach a packaged VSIX for `alpha`, `beta` / `rc`, and stable lanes.
- Visual Studio Marketplace publication is optional and runs only when `VSCE_TOKEN` is configured; until then, GitHub release assets remain the canonical install path.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `kin.binaryPath` | `""` | Path to the kin binary. Empty = auto-detect (`~/.kin/bin/kin` or PATH). |
| `kin.autoStart` | `true` | Auto-activate when `.kin/` exists in workspace. |
| `kin.mcpEnabled` | `true` | Use a persistent MCP connection for zero-overhead graph queries. Disable to fall back to CLI subprocess per command. |

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `Kin: Semantic Search` | `Cmd+Shift+K S` | Search entities by name |
| `Kin: Graph Overview` | `Cmd+Shift+K O` | Show graph statistics |
| `Kin: Trace Entity` | `Cmd+Shift+K T` | Trace entity through the graph |
| `Kin: Review Current File` | `Cmd+Shift+K V` | Semantic code review with gutter decorations |
| `Kin: Refresh Entity Explorer` | `Cmd+Shift+K R` | Re-index the entity tree |
| `Kin: Initialize Repository` | -- | Run `kin init` in the workspace |
| `Kin: Show Status` | -- | Show entity count and connection mode |

On Linux/Windows, replace `Cmd` with `Ctrl`.

## Architecture

The extension uses an MCP-first architecture with CLI fallback. On activation, it spawns a persistent MCP connection to `kin mcp start` over stdio (JSON-RPC 2.0 with Content-Length framing). All graph queries -- search, trace, overview, status, review -- route through MCP for zero-overhead access to the in-memory graph. If the MCP connection is unavailable, each query transparently falls back to a CLI subprocess call (`execFile`).

Key components:
- **McpClient** (`mcp-client.ts`) -- Manages the MCP process lifecycle, auto-reconnects on crash, and handles the initialize handshake.
- **KinClient** (`kin-client.ts`) -- Unified query interface that tries MCP first, then falls back to CLI. All commands consume this.
- **WorkspaceManager** (`workspace-manager.ts`) -- Multi-root workspace support with per-folder MCP connections.
- **Language Providers** -- HoverProvider, DefinitionProvider, WorkspaceSymbolProvider, and RenameProvider hook into VS Code's native APIs backed by the Kin graph.

The `kin.mcpEnabled` setting controls whether MCP is used. When disabled, all queries go through CLI subprocesses (5-50ms overhead per command).

## License

Apache-2.0. Copyright 2026 Firelock LLC.
