# Kin for Visual Studio Code

**AI writes code. Kin proves the change.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Part of Kin](https://img.shields.io/badge/part%20of-Kin-6E56CF.svg)](https://github.com/firelock-ai/kin)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC.svg)](https://marketplace.visualstudio.com/items?itemName=firelock.kin-editor)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Registry-C160EF.svg)](https://open-vsx.org/extension/Firelock/kin-editor)

`kin-editor` brings Kin's graph into Visual Studio Code: entity explorer,
natural-language semantic search, trace, go-to-definition, graph-backed review,
and semantic rename, with live daemon and graph health in the status bar.

The extension does not implement a second index. It delegates queries to the
local Kin runtime over MCP and falls back to the `kin` CLI when that connection
is unavailable. Start with **[Kin](https://github.com/firelock-ai/kin)**, the
semantic system of record for AI-written software.

## Install, set up, query

### 1. Install Kin and initialize the repository

On macOS or Linux:

```sh
curl -fsSL https://get.kinlab.dev/install | sh
exec "$SHELL" -l
kin setup --intent editor

cd /path/to/your/repository
kin init .
kin embed
kin status
```

Use the [Kin quickstart](https://github.com/firelock-ai/kin/blob/main/docs/quickstart.md)
for Homebrew, npm, Windows, installer options, and platform limitations.
`kin status` should report an initialized graph and complete embedding coverage
before the natural-language query path is considered ready. Embedding time
scales with repository size; graph overview, entity browsing, and name search
remain available without vectors.

### 2. Install the extension

Install from the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=firelock.kin-editor)**,
search for extension ID `firelock.kin-editor`, or run:

```sh
code --install-extension firelock.kin-editor
```

The same published extension is available from the
**[Open VSX Registry](https://open-vsx.org/extension/Firelock/kin-editor)**.
Open VSX is a distribution channel, not a claim that every editor fork is a
supported client. The documented and tested editor surface here is Visual
Studio Code 1.85 or newer.

To build a local VSIX from source:

```sh
npm install
npm run package:vsix
# In VS Code, run: Extensions: Install from VSIX...
```

### 3. Run the first graph query

1. Open the initialized repository in VS Code and reload the window after the
   first `kin init`.
2. Open the Command Palette and run **Kin: Setup Workspace**. The panel checks
   the real `kin setup status` health report rather than fabricating editor-only
   readiness.
3. Run **Kin: Semantic Search** (`Cmd+Shift+K S` on macOS or
   `Ctrl+Shift+K S` elsewhere).
4. Enter a question such as `where are webhook retries handled` and choose a
   graph entity from the result picker.
5. Put the cursor on a returned symbol and run **Kin: Trace Entity** to inspect
   its related and calling entities.

Semantic Search calls Kin's `semantic_locate` MCP tool when the persistent MCP
connection is healthy. Its CLI fallback is graph-backed name-pattern search,
not equivalent vector/natural-language retrieval. The status surface labels the
active path as MCP or CLI, and the extension never searches files on its own.

## Features

- **Entity Explorer:** semantic entities from the graph rather than another
  filesystem tree.
- **Semantic Search** (`Cmd/Ctrl+Shift+K S`): natural-language retrieval through
  `semantic_locate`, with results in a navigable picker. Workspace symbol search
  (`Cmd/Ctrl+T`) uses Kin's name-pattern graph search.
- **Trace** (`Cmd/Ctrl+Shift+K T`): focal entity and nearby semantic context.
  The same graph data supports go-to-definition (`F12`) and hover.
- **Graph Overview** (`Cmd/Ctrl+Shift+K O`): indexed language, entity, and graph
  summary for the active workspace.
- **Review** (`Cmd/Ctrl+Shift+K V`): report-only Kin review surfaced as gutter
  decorations, diagnostics, and the `Kin Review` output channel.
- **Rename** (`F2`): a Kin rename plan for the selected entity and its graph
  references.
- **Status Bar:** MCP/CLI connection, indexed entity count, graph state, and
  health warnings such as a mass-deletion safety block.
- **Multi-root workspaces:** commands resolve the active file's owning workspace
  before selecting its Kin client.

## Runtime behavior and settings

On activation, the extension launches `kin mcp start` for each initialized
workspace. That process starts or reuses the repository daemon; there is no
separate daemon-start step. If no workspace contains `.kin/`, every Kin command
still appears and guides the user to **Kin: Initialize Repository** or
**Kin: Setup Workspace**.

| Setting | Default | Purpose |
| --- | --- | --- |
| `kin.binaryPath` | auto-detect | Absolute `kin` binary path. Empty checks `~/.kin/bin/kin` and `PATH`. |
| `kin.mcpEnabled` | `true` | Keep a persistent MCP connection; disable to use one CLI subprocess per command. |

The extension requires the local Kin CLI and daemon. It does not require a
hosted KinLab login, and it does not make the still-upcoming hosted repository
connection flow available early.

## Ecosystem

| Surface | Role |
| --- | --- |
| [kin](https://github.com/firelock-ai/kin) | Semantic system of record, CLI, daemon, MCP, review, and provenance |
| [kin-vfs](https://github.com/firelock-ai/kin-vfs) | Transparent graph-backed filesystem projection |
| [kin-db](https://github.com/firelock-ai/kin-db) | Graph storage, indexing, and retrieval substrate |
| [KinLab](https://kinlab.ai) | Hosted collaboration and control plane |

## Support

- [Kin Discussions](https://github.com/firelock-ai/kin/discussions)
- [kin-editor issues](https://github.com/firelock-ai/kin-editor/issues)
- [Kin security policy](https://github.com/firelock-ai/kin/security/policy)

## License

[Apache-2.0](LICENSE).
