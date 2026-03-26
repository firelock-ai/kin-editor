# Kin - Semantic VCS for VS Code

Semantic code intelligence powered by [Kin](https://github.com/nicholasgasior/kin-ecosystem/tree/main/kin)'s graph engine.

## Features

- **Entity Explorer** -- Browse functions, classes, modules, and other entities in a sidebar tree view grouped by kind.
- **Semantic Search** -- Ctrl+Shift+P > "Kin: Semantic Search" to find entities by name with quick navigation to source.
- **Entity Trace** -- Right-click in the editor to trace an entity through the dependency graph.
- **Status Bar** -- Live entity count in the bottom bar. Click for a graph overview.
- **Graph Overview** -- See entity counts, edge counts, and kind breakdowns at a glance.

## Requirements

- The `kin` CLI binary must be installed (`~/.kin/bin/kin` or on PATH).
- A Kin-initialized repository (`.kin/` directory in workspace root).

## Installation

1. Build the extension: `npm install && npm run compile`
2. Package: `npx @vscode/vsce package`
3. Install the `.vsix` file in VS Code: Extensions > "..." > "Install from VSIX..."

Or for development: open this folder in VS Code and press F5 to launch the Extension Development Host.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `kin.binaryPath` | `""` | Path to the kin binary. Empty = auto-detect. |
| `kin.autoStart` | `true` | Auto-activate when `.kin/` exists in workspace. |

## Commands

| Command | Description |
|---------|-------------|
| `Kin: Semantic Search` | Search entities by name |
| `Kin: Graph Overview` | Show graph statistics |
| `Kin: Trace Entity` | Trace entity through the graph |
| `Kin: Initialize Repository` | Run `kin init` |
| `Kin: Show Status` | Show Kin status |
| `Kin: Refresh Explorer` | Re-index the entity tree |

<!-- TODO: screenshots -->

## License

Apache-2.0. Copyright 2026 Firelock LLC.
