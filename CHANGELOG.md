# Changelog

All notable changes to the Kin VS Code extension are documented in this file.

## [0.1.8] - 2026-08-31

### Changed

- Fix MCP response framing by byte length (#88)

## [0.1.7] - 2026-08-29

### Changed

- Order the editor first-run around the graph, and price the embed step (#85)

## [0.1.6] - 2026-08-29

### Changed

- Give the extension a first run, and key the ready banner on the health verdict (#83)

## [0.1.5] - 2026-08-29

### Changed

- Unblock the packager and make a types-versus-engines mismatch fail on the PR (#78)

## [0.1.4] - 2026-08-29

### Changed

- Honour the daemon's still-starting retry signal instead of emptying the pane (#75)
- Pin the CLI fallback contract to the shipped CLI and make drift visible (#74)
- chore(deps-dev): bump @typescript-eslint/eslint-plugin from 8.65.0 to 8.67.0 (#64)
- chore(deps): bump actions/checkout from 7.0.0 to 7.0.1 (#45)
- Re-key the bug report version placeholders to the shipping versions (#62)
- chore(deps-dev): bump @types/vscode from 1.85.0 to 1.125.0 (#46)
- chore(deps-dev): bump eslint from 10.8.0 to 10.8.1 (#63)
- chore(deps-dev): bump @typescript-eslint/parser from 8.65.0 to 8.67.0 (#65)
- chore(deps-dev): bump ovsx from 1.0.2 to 1.1.1 (#66)
- Replace marketplace displayName with the locked category noun (#67)
- Surface merge-queue ejections on the pull request they hit (#68)
- Make every declared contribution answer, and say when Kin is unreachable (#61)

## [0.1.3] - 2026-08-12

### Changed

- Drop the kin.autoStart setting that nothing reads (#58)
- Rewrite the em dashes out of the public docs (#57)

## [0.1.2] - 2026-08-07

### Changed

- Read the release Train merge policy with the App token instead of the workflow token (#52)
- Refuse assistant-session traces in pull request text (#51)
- Read the CI runs payload from a file instead of jq's argv (#49)
- Move js-yaml past the omap quadratic-CPU advisory (#50)
- Replace the extension's visual identity with the current brand system (#48)
- Refresh brand lockup and icon assets (#47)
- Give each main-branch push its own CI concurrency group (#44)
- Automate Kin Editor releases (#40)
- chore(deps-dev): bump @types/node from 20.19.43 to 26.1.2 (#33)
- Run CI on merge queue groups (#43)
- Rasterize README lockup hero to PNG for vsce packaging (#42)
- Pin @types/vscode to the declared 1.85 engine floor (#41)
- Merge pull request #39 from firelock-ai/docs/readme-hero
- docs: clarify Git hook safety (#37)
- chore(deps): bump softprops/action-gh-release from 2 to 3 (#28)
- chore(deps): bump actions/setup-node from 6 to 7 (#26)
- chore(deps): bump actions/checkout from 6 to 7 (#27)
- Modernize lint and test toolchain and clear the dependency audit (#38)
- chore(deps-dev): bump @types/vscode from 1.110.0 to 1.125.0 (#30)
- Fix CODEOWNERS to a valid owner handle (#35)
- Lead README with brand canon hero (#34)
- chore: add community scaffolding, drop internal ref, fix Open VSX case (#25)
- chore: remove ticket references from release-policy comments (#24)
- Merge pull request #23 from firelock-ai/docs/tagline-align
- Merge pull request #22 from firelock-ai/docs/editor-onboarding
- Merge pull request #21 from firelock-ai/docs/readme-polish
- Fail closed on editor marketplace publication (#20)
- Merge pull request #18 from firelock-ai/docs/editor-onboarding

## [0.1.1] - 2026-07-10

### Fixed

- Kin commands now register on workspaces that have not been initialized yet:
  search, overview, trace, status, review, and refresh guide the user into
  setup instead of failing with "command not found" on a fresh machine.
  First-run behavior on macOS, Windows, and Linux is locked down by an
  executable acceptance matrix. (#10)

### Added

- Explicit graph availability states (indexed, empty, not-indexed,
  unavailable, invalid-response): an unreachable or garbled daemon now
  reports its state honestly instead of rendering as an empty graph. (#12)
- Live MCP integration coverage: the client is exercised against a real
  subprocess speaking the MCP wire protocol, covering the initialize
  handshake, tool calls, error surfacing, crash and reconnect, and
  per-workspace targeting. (#12)
- Release policy metadata and enforcement: version bumps, publish targets,
  and CLI/daemon/MCP compatibility are policy-gated in CI, and the
  compatibility record is source-checked against the code so it cannot
  drift. (#13)

### Changed

- The published VSIX no longer ships compiled test files. (#13)
- CI runs each pull-request commit once and cancels superseded runs. (#14)
- README and marketplace copy carry the locked public one-liner and category
  wording. (#15, #16)

## [0.1.0] - 2026-06-26

Initial release: entity explorer, semantic search, trace, rename and review
providers, status bar, setup health, and MCP-powered daemon integration.
