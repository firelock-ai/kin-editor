# Kin Editor: Semantic VS Code Extension

`kin-editor` is a lightweight Visual Studio Code extension (~500 LOC) that exposes Kin's semantic repository features directly in the editor UI. Because the virtual filesystem (`kin-vfs`) handles transparent file reads, `kin-editor` focuses purely on user interface surfaces and helper commands.

## Features

- **Entity Explorer**: A sidebar view tree of all semantic entities (classes, functions, interfaces) in the workspace graph, bypassing the filesystem tree.
- **Semantic Search**: Direct integration with `kin search` to query the codebase using vector similarity or regex patterns.
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
npm run package
```
This packages the extension into a `.vsix` file which can be installed manually in VS Code.
