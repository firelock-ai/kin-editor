<p align="center">
  <img src="brand/kin-banner-dark.png" alt="Kin for Visual Studio Code" width="100%" />
</p>

# Kin for Visual Studio Code

> **Software that remembers itself.**
>
> Exact context, not more.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Part of Kin](https://img.shields.io/badge/part%20of-Kin-6E56CF.svg)](https://github.com/firelock-ai/kin)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC.svg)](https://marketplace.visualstudio.com/items?itemName=firelock.kin-editor)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Registry-C160EF.svg)](https://open-vsx.org/extension/firelock/kin-editor)

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

cd /path/to/your/repository
kin init .
kin setup --intent editor
kin status
```

`kin init` is the slow step and the one everything else rests on. It admits your
Git history into the graph, and every panel in this extension reads that graph
rather than the files on disk. Run it before `kin setup` so setup has a
repository to check.

Natural-language semantic search additionally needs vectors, which admission
does not build. Add them with `kin embed`. The first run on a machine downloads
about 523 MB of embedding model before anything is indexed, so it is worth
starting deliberately rather than in the middle of the install. The entity
explorer, trace, and name search all answer before that finishes, and
`kin status` reports embedding coverage so you can see where it is.

Use the [Kin quickstart](https://github.com/firelock-ai/kin/blob/main/docs/quickstart.md)
for Homebrew, npm, Windows, installer options, and platform limitations.

### 2. Install the extension

Install from the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=firelock.kin-editor)**,
search for extension ID `firelock.kin-editor`, or run:

```sh
code --install-extension firelock.kin-editor
```

The same published extension is available from the
**[Open VSX Registry](https://open-vsx.org/extension/firelock/kin-editor)**.
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
  The same graph data supports go-to-definition (`F12`) and hover, which both
  need the MCP connection. See the runtime notes below.
- **Graph Overview** (`Cmd/Ctrl+Shift+K O`): entity count for the active
  workspace, plus edge, file, and entity-kind counts when the daemon reports
  them. States the graph can be in, such as unreachable or still indexing, are
  named rather than shown as zeros.
- **Review** (`Cmd/Ctrl+Shift+K V`): report-only Kin review surfaced as gutter
  decorations, diagnostics, and the `Kin Review` output channel.
- **Rename** (`F2`): a Kin rename plan for the selected entity and its graph
  references.
- **Status Bar:** indexed entity count, or an honest `not initialized` or
  `unavailable` state. Click it for the overview. `Kin: Show Status` is what
  reports the active MCP or CLI path and the graph state.
- **Multi-root workspaces:** commands resolve the active file's owning workspace
  before selecting its Kin client. The entity explorer and the status bar follow
  the first Kin-initialized folder in the workspace.

## Runtime behavior and settings

With `kin.mcpEnabled` at its default, the extension launches `kin mcp start` on
activation for each initialized workspace. That process starts or reuses the
repository daemon; there is no separate daemon-start step. Turning the setting
off runs one `kin` CLI subprocess per command instead, and either path needs the
local `kin` binary. If no workspace contains `.kin/`, every Kin command
still appears and guides the user to **Kin: Initialize Repository** or
**Kin: Setup Workspace**.

| Setting | Default | Purpose |
| --- | --- | --- |
| `kin.binaryPath` | auto-detect | Absolute `kin` binary path. Empty checks `~/.kin/bin/kin` and `PATH`. |
| `kin.mcpEnabled` | `true` | Keep a persistent MCP connection; disable to use one CLI subprocess per command. |

Hover and go-to-definition are the exception to that fallback. They fire on
every word the cursor touches, so they run only over the MCP connection rather
than spawning a subprocess per lookup. With `kin.mcpEnabled` off, or before the
connection comes up, they return nothing and stay quiet. Search, trace,
overview, status, review, and rename all keep working over the CLI.

When neither path answers, the status bar reads `Kin: unavailable` and
`Kin: Show Status` says the runtime could not be reached. Neither surface
reports an unreachable daemon as an uninitialized repository.

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
