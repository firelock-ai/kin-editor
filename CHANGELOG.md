# Changelog

## 0.1.0 (2026-03-25)

First release -- full semantic code intelligence for VS Code, Cursor, VSCodium, and Windsurf.

### Core
- MCP-first architecture: persistent connection to `kin mcp start` over stdio for zero-overhead graph queries, with automatic CLI fallback
- Multi-root workspace support via WorkspaceManager with per-folder MCP connections
- Auto-reconnect on MCP process crash (5s backoff)

### Features
- **Entity Explorer** -- sidebar tree view grouped by entity kind with refresh command
- **Semantic Search** -- Quick Pick search routed through MCP `semantic_search` tool
- **Entity Trace** -- Quick Pick trace via MCP `find_references` tool
- **Hover Provider** -- entity info on hover for all file types (debounced, 300ms)
- **Go to Definition** -- F12 / Ctrl+Click resolves through the Kin graph
- **Workspace Symbol Provider** -- Cmd+T / Ctrl+T symbol search via MCP
- **Semantic Review** -- entity-level code review with gutter decorations (error/warning/info) and VS Code diagnostics
- **Semantic Rename** -- F2 rename through Kin rename plans with cross-file workspace edits
- **Graph Overview** -- entity, edge, file counts and kind breakdowns
- **Status Bar** -- live entity count, connection mode indicator (MCP/CLI), click for overview
- **Initialize Repository** -- `kin init` command for new workspaces

### Configuration
- `kin.binaryPath` -- custom binary path with auto-detect fallback
- `kin.autoStart` -- auto-activate when `.kin/` directory exists
- `kin.mcpEnabled` -- toggle MCP connection (enabled by default)

### Keybindings
- `Cmd+Shift+K S` -- Semantic Search
- `Cmd+Shift+K T` -- Trace Entity
- `Cmd+Shift+K O` -- Graph Overview
- `Cmd+Shift+K R` -- Refresh Entity Explorer
- `Cmd+Shift+K V` -- Review Current File

### Accessibility
- Screen reader support for entity explorer, search, and trace quick-picks
- Theme-driven gutter icons for review findings
- All commands grouped under `Kin` category in Command Palette

### Compatibility
- Verified on VS Code 1.85+, VSCodium 1.112, Cursor 2.6, Windsurf 1.108
