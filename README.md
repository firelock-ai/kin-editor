# kin-editor

**AI writes code. Kin records what it means.**

The Visual Studio Code extension for Kin: an entity explorer, semantic search, trace with go-to-definition, graph-backed review, and semantic rename, all surfaced through a live status bar.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Part of Kin](https://img.shields.io/badge/part%20of-Kin-6E56CF.svg)](https://github.com/firelock-ai/kin)

`kin-editor` is a lightweight extension (about 3K production lines) that surfaces Kin's semantic graph directly in the editor. It holds no graph logic of its own: every query is delegated to the local Kin daemon over MCP, with a `kin` CLI fallback.

## What is Kin?

Kin is the semantic system of record for AI-written software: your code as a graph of entities, relations, and intents rather than a pile of files and diffs. AI agents and humans navigate it semantically, with provenance and review alongside. It coexists with Git and projects graph truth back to a normal filesystem, so existing tools keep working unchanged.

Start at **[firelock-ai/kin](https://github.com/firelock-ai/kin)**. Learn more at **[kinlab.ai](https://kinlab.ai)**.

## Install

**VS Code Marketplace**

```
ext install firelock.kin-editor
```

Or search **"Kin"** in the VS Code Extensions panel.

**Open VSX** (VSCodium and other open-source VS Code builds)

Search **"Kin"** or install by ID: `firelock.kin-editor`.

**From source**, build and install a `.vsix` locally:

```sh
npm install
npm run package:vsix
# Then run "Extensions: Install from VSIX..." in VS Code.
```

## Setup

Configure Kin for editor use once:

```sh
kin setup --intent editor
```

Initialize each workspace with `kin init .` if it does not already contain
`.kin/`, then run `kin status` to inspect its working-copy state. On activation
the extension launches `kin mcp start`, which starts or reuses the repository
daemon automatically. There is no separate daemon start command.

The extension keeps a persistent MCP connection for graph queries and falls
back to `kin` CLI subprocesses when that connection is unavailable. Three
settings tune this behavior: `kin.binaryPath`, `kin.autoStart`, and
`kin.mcpEnabled`.

## Features

- **Entity Explorer:** a sidebar tree of semantic entities (classes, functions,
  interfaces) drawn from the graph rather than the filesystem tree.
- **Semantic Search** (`⌘⇧K S`): the `Kin: Semantic Search` command routes to the
  graph's vector and natural-language retrieval through `semantic_locate` over MCP
  and lists matches in a picker. The same graph search backs VS Code workspace
  symbol search (`⌘T`).
- **Trace** (`⌘⇧K T`): the `Kin: Trace Entity` command resolves the symbol under the
  cursor to its related and calling entities and lists them in a navigable picker.
  The same trace data powers go-to-definition (`F12`) and hover.
- **Graph Overview** (`⌘⇧K O`): the `Kin: Graph Overview` command reports a summary
  of the current graph.
- **Review** (`⌘⇧K V`): the `Kin: Review Current File` command runs Kin review and
  surfaces findings as editor gutter decorations, diagnostics, and a "Kin Review"
  output channel. Review is report-only; it reports findings and does not block.
- **Rename** (`F2`): semantic rename routed through Kin rename plans.
- **Status Bar:** live daemon connection state, indexed entity count, graph state,
  and health warnings (for example, mass-deletion blocks).

## Ecosystem

| Repo | Role |
|------|------|
| [kin](https://github.com/firelock-ai/kin) | Semantic system of record: CLI, daemon, MCP server, projections |
| [kin-db](https://github.com/firelock-ai/kin-db) | Semantic engine: graph storage, indexing, retrieval |
| [kin-vfs](https://github.com/firelock-ai/kin-vfs) | Transparent filesystem projection |
| [kinlab](https://kinlab.ai) | Hosted collaboration and control plane |

## License

[Apache-2.0](LICENSE).
