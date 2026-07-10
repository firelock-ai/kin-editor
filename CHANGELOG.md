# Changelog

All notable changes to the Kin VS Code extension are documented in this file.

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
