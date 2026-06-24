# Kin Editor: Semantic VS Code Extension

`kin-editor` is a lightweight Visual Studio Code extension (~3K LOC of production TypeScript, tests excluded) that exposes Kin's semantic repository features directly in the editor UI. Because the virtual filesystem (`kin-vfs`) handles transparent file reads, `kin-editor` focuses purely on user interface surfaces and helper commands.

## Features

- **Entity Explorer**: A sidebar view tree of all semantic entities (classes, functions, interfaces) in the workspace graph, bypassing the filesystem tree.
- **Semantic Search**: The **Kin: Semantic Search** command routes to the graph's `semantic_locate` (vector / natural-language) retrieval over MCP — not substring matching — falling back to the `kin search` CLI when the daemon is unavailable. (The Cmd+T workspace-symbol provider uses name-pattern matching via `semantic_search`, where VS Code expects prefix filtering.)
- **Trace Visualization**: View calling relationships, computational paths, and dataflow graphs directly inside VS Code panels.
- **Status Bar Integration**: Visual indicators showing the daemon's connection status, background sync progress, and health warnings (e.g. mass deletion blocks).

## Extension Structure

- **`src/`**: TypeScript source code implementing VS Code tree views, search providers, webview panels, and commands.
- **`resources/`**: Static webview assets (icons, styles, scripts) for rendering trace and explorer panels.
- **`package.json`**: Extension manifest declaring VS Code activation events, settings, custom views, and command registrations.

## Local Installation

To build and package the extension locally:
```sh
npm install
npm run package:vsix
```
This packages the extension into a `.vsix` file which can be installed manually in VS Code.
