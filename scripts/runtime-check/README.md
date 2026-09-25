# Runtime check

A repeatable check that the packaged extension works inside a real VS Code.
Unit tests in `src/__tests__` mock the VS Code API. This check runs the real one.

`run.mjs` downloads VS Code with `@vscode/test-electron` and installs a
kin-editor VSIX into an empty extensions directory. It points the extension at
a given `kin` binary and opens a small Python fixture repository. It then drives
the released behavior from inside the extension host:

1. The extension installed from the VSIX activates.
2. The Graph Browser and the Entity Explorer render the fixture's entities.
3. Clicking a Graph Browser row opens a `kin://` document that matches what
   the daemon holds.
4. Trace Entity runs from the cursor the way a keyboard user runs it. Enter
   accepts the input box, then Enter accepts the first result. The check
   requires Kin to trace the word under the cursor and the editor to open that
   first result.
5. When the build contributes draft editing, the check edits a draft, saves it
   and applies it, then reads it back three ways:
   - a fresh `kin://` read
   - the working-copy file on disk
   - the daemon over MCP
6. VS Code and the Kin daemon both restart. A second session loads the Graph
   Browser, reopens the entity and reopens the saved draft.

A step whose feature the installed build lacks is recorded as `not_shipped`
rather than as passed or failed. A build without `kin.editEntity` gets that
status for draft save and apply.

## Run it

```bash
cd scripts/runtime-check
npm ci
node run.mjs --kin-release v0.7.21 --vsix-release latest
```

Linux needs a display, so run it under Xvfb:

```bash
xvfb-run -a node run.mjs --kin-release v0.7.21 --vsix-release latest
```

The Kin binary comes from `--kin <path>`, `--kin-release <tag>` or
`--kin-archive <path|url>`. The extension comes from `--vsix <path|url>`,
`--vsix-release <tag|latest>` or `--vsix-from-source <kin-editor checkout>`.
`--vscode` picks the VS Code version: `stable` by default, `insiders`, or an
exact version. Run `node run.mjs --help` for the rest.

## What it leaves behind

Each run writes one evidence directory, `.results/<stamp>-<platform>` by
default:

- `result.json` records the VS Code, extension and Kin versions and hashes, and
  every step.
- `summary.md` repeats that record as a table.
- `session-first/` and `session-restart/` keep the extension host's own
  results, the VS Code output and the VS Code logs.

The exit code is 0 only when no step failed.

Everything runs under a throwaway `HOME`, `KIN_HOME` and VS Code profile in a
short `/tmp` path. The run stops the daemons and the supervisor it started,
signals any process that still names its throwaway directory, and then removes
that directory. It never touches your own Kin registry, daemons or editor
settings.

## Limits

- The check turns off language-server enrichment, embeddings and model
  downloads. The graph it grades is what a plain parse produces.
- The VS Code profile uses `--use-inmemory-secretstorage`, so OS keychain
  integration is not graded.
- The restart is `kin daemon stop` followed by a cold start. Power loss is
  outside what it grades.
