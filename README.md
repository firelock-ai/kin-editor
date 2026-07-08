# kin-editor

> The VS Code extension for Kin: entity explorer, semantic search, trace, rename/review providers, and status bar.

`kin-editor` is a lightweight Visual Studio Code extension (~3K production LOC) that surfaces Kin's semantic graph directly in the editor. It is part of the Kin ecosystem — code as a graph of entities, relations, and intents, not files and diffs.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Part of Kin](https://img.shields.io/badge/part%20of-Kin-6E56CF.svg)](https://github.com/firelock-ai/kin)

## What is Kin?

Kin is the semantic system of record for software work — your code as a graph of
entities, relations, and intents, not a pile of files and diffs. AI agents and humans
navigate it semantically, with provenance, review, and governance built in. It coexists
with Git and projects graph truth back to a normal filesystem, so any tool works unchanged.

Start at **[firelock-ai/kin](https://github.com/firelock-ai/kin)** · **[kinlab.ai](https://kinlab.ai)**

## Install

**VS Code Marketplace**

```
ext install firelock.kin-editor
```

Or search **"Kin"** in the VS Code Extensions panel.

**Open VSX** (VSCodium / open-source VS Code builds)

Search **"Kin"** or install by ID: `firelock.kin-editor`

**From source** — build and install a `.vsix` locally:

```sh
npm install
npm run package:vsix
# Then: Extensions → "Install from VSIX…" in VS Code
```

## kin-editor's role

The extension requires a running Kin daemon (`kin daemon start`) in the workspace.
It connects over MCP for zero-overhead graph queries and falls back to the `kin`
CLI subprocess when the daemon is unavailable.

Features:

- **Entity Explorer** — sidebar tree of all semantic entities (classes, functions,
  interfaces) drawn directly from the graph, bypassing the filesystem tree.
- **Semantic Search** — the `Kin: Semantic Search` command (`⌘⇧K S`) routes to the
  graph's vector/natural-language retrieval via `semantic_locate` over MCP.
- **Trace Visualization** — calling relationships, computational paths, and dataflow
  graphs rendered inside VS Code panels (`⌘⇧K T`).
- **Review Provider** — the `Kin: Review Current File` command (`⌘⇧K V`) surfaces
  graph-backed review annotations in the active editor.
- **Status Bar** — live daemon connection state, background sync progress, and health
  warnings (e.g. mass-deletion blocks).

## Ecosystem

| Repo | Role |
|------|------|
| [kin](https://github.com/firelock-ai/kin) | Semantic system of record — CLI, daemon, MCP server, projections |
| [kin-db](https://github.com/firelock-ai/kin-db) | Semantic engine — graph storage, indexing, retrieval |
| [kin-vfs](https://github.com/firelock-ai/kin-vfs) | Transparent filesystem projection |
| [kinlab](https://kinlab.ai) | Hosted collaboration and control plane |

## License

[Apache-2.0](LICENSE).
