// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Fresh-machine first-run acceptance matrix for the VS Code setup UX.
//
// This suite encodes the cross-platform (macOS / Windows / Linux) first-run
// contract the editor must honour against the released CLI/daemon/MCP path:
// the setup-health checklist, status-bar copy, overview/error copy, and the
// recovery affordances (doctor --fix, Initialize Repository). Every assertion
// drives the SAME pure functions the extension renders from, so a regression in
// first-run copy or state classification fails here.
//
// Scope note: driving a real VS Code window against a freshly installed CLI on
// three physical operating systems cannot be simulated hermetically, so that
// live capture is tracked separately. What is provable in-process —
// that each platform's health report parses, that platform-specific states are
// surfaced honestly, and that the exact user-facing copy matches the M1.5 setup
// UX — is locked down here so the live pass only has to confirm the screens
// match this asserted matrix.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { BinaryNotFoundError, ParseError, TimeoutError } from "../errors";

jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: () => ({ get: () => "" }),
    },
  }),
  { virtual: true }
);

jest.mock("child_process");
jest.mock("fs");

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;

import {
  HealthCheck,
  HealthReport,
  HealthStatusValue,
  hasFixableChecks,
  isFailing,
  parseHealthReport,
  runSetupStatus,
} from "../setup-health";
import {
  describeError,
  formatOverviewMessage,
  formatStatusBarText,
  formatStatusBarTooltip,
} from "../accessibility";

// ---------------------------------------------------------------------------
// Platform fixtures — the shape is the real serde `HealthReport` emitted by
// `kin setup status --json` (see setup-health.test.ts for the canonical shape).
// Each fixture models a *fresh machine* first run: the CLI is installed, MCP
// clients are wired by `kin setup`, but the workspace has not been initialised
// yet — the exact moment the setup UX is meant to guide the user through.
// ---------------------------------------------------------------------------

function check(partial: Partial<HealthCheck> & { id: string; status: HealthStatusValue }): HealthCheck {
  return {
    label: partial.label ?? partial.id,
    detail: partial.detail ?? "",
    platform_note: partial.platform_note ?? null,
    fixable: partial.fixable ?? false,
    manual_fix: partial.manual_fix ?? null,
    ...partial,
  };
}

interface PlatformCase {
  platform: string;
  /** How VFS projection reports on this platform on a fresh machine. */
  vfs: HealthCheck;
  /** Human label used in test titles. */
  title: string;
}

const MACOS: PlatformCase = {
  platform: "macos",
  title: "macOS",
  vfs: check({
    id: "vfs_projection",
    label: "VFS projection",
    status: "healthy",
    detail: "FUSE-T available",
  }),
};

const LINUX: PlatformCase = {
  platform: "linux",
  title: "Linux",
  vfs: check({
    id: "vfs_projection",
    label: "VFS projection",
    status: "healthy",
    detail: "libfuse available",
  }),
};

const WINDOWS: PlatformCase = {
  platform: "windows",
  title: "Windows",
  // Windows projection is honestly reported as unsupported when ProjFS is off.
  // `unsupported` must be surfaced but must NOT flip the overall report to
  // unhealthy — projection is optional, not a setup failure.
  vfs: check({
    id: "vfs_projection",
    label: "VFS projection",
    status: "unsupported",
    detail: "ProjFS not enabled",
    platform_note: "Windows VFS projection requires ProjFS",
    manual_fix: "enable the Projected File System Windows feature",
  }),
};

const PLATFORMS = [MACOS, LINUX, WINDOWS];

/** A fresh-machine first-run report: CLI healthy, repo not initialised yet. */
function freshMachineReport(p: PlatformCase): string {
  return JSON.stringify({
    platform: p.platform,
    checks: [
      check({ id: "kin_binary", label: "Kin CLI", status: "healthy", detail: "kin 0.2.6 on PATH" }),
      check({
        id: "repo_init",
        label: "Repository initialized",
        status: "missing",
        detail: "no .kin/ directory here",
        manual_fix: "run `kin init .` to initialize a repository here",
      }),
      p.vfs,
      check({
        id: "mcp_client_claude",
        label: "MCP: Claude Code",
        status: "healthy",
        detail: "mcpServers.kin configured",
      }),
      check({ id: "editor", label: "Editor integration", status: "healthy", detail: "kin-editor extension active" }),
    ],
    healthy: false,
  });
}

/** A fully-configured report: setup complete, repo initialised. */
function readyReport(p: PlatformCase): string {
  return JSON.stringify({
    platform: p.platform,
    checks: [
      check({ id: "kin_binary", label: "Kin CLI", status: "healthy", detail: "kin 0.2.6 on PATH" }),
      check({ id: "repo_init", label: "Repository initialized", status: "healthy", detail: ".kin/ present" }),
      p.vfs,
      check({ id: "mcp_client_claude", label: "MCP: Claude Code", status: "healthy", detail: "mcpServers.kin configured" }),
      check({ id: "editor", label: "Editor integration", status: "healthy", detail: "kin-editor extension active" }),
    ],
    healthy: true,
  });
}

describe("first-run matrix — setup health checklist per platform", () => {
  for (const p of PLATFORMS) {
    describe(p.title, () => {
      it("parses the fresh-machine report and surfaces the platform", () => {
        const report = parseHealthReport(freshMachineReport(p));
        expect(report.platform).toBe(p.platform);
        expect(report.checks).toHaveLength(5);
      });

      it("classifies an un-initialised workspace as needing attention (repo_init fails)", () => {
        const report = parseHealthReport(freshMachineReport(p));
        const repoInit = report.checks.find((c) => c.id === "repo_init")!;
        expect(isFailing(repoInit.status)).toBe(true);
        // The setup panel keys the "Initialize Repository" button off exactly
        // this predicate — a fresh machine must offer it.
        expect(report.checks.some((c) => c.id === "repo_init" && c.status !== "healthy")).toBe(true);
        expect(report.healthy).toBe(false);
      });

      it("reports a fully-configured workspace as ready", () => {
        const report = parseHealthReport(readyReport(p));
        expect(report.healthy).toBe(true);
        expect(report.checks.every((c) => !isFailing(c.status))).toBe(true);
      });
    });
  }

  it("surfaces Windows VFS projection honestly: unsupported, with a platform note, but not a failure", () => {
    const report = parseHealthReport(freshMachineReport(WINDOWS));
    const vfs = report.checks.find((c) => c.id === "vfs_projection")!;
    expect(vfs.status).toBe("unsupported");
    expect(vfs.platform_note).toBe("Windows VFS projection requires ProjFS");
    // `unsupported` is surfaced but does not flip the overall report unhealthy;
    // only `repo_init` (missing) does here.
    expect(isFailing(vfs.status)).toBe(false);
  });

  it("macOS and Linux report VFS projection as available on a fresh machine", () => {
    for (const p of [MACOS, LINUX]) {
      const vfs = parseHealthReport(freshMachineReport(p)).checks.find((c) => c.id === "vfs_projection")!;
      expect(vfs.status).toBe("healthy");
    }
  });
});

describe("first-run matrix — recovery affordances", () => {
  it("offers `kin doctor --fix` when a fixable check is unhealthy", () => {
    const report: HealthReport = parseHealthReport(
      JSON.stringify({
        platform: "macos",
        checks: [
          check({ id: "kin_binary", status: "healthy" }),
          check({
            id: "mcp_client_claude",
            label: "MCP: Claude Code",
            status: "misconfigured",
            detail: "profile wrong",
            fixable: true,
            manual_fix: "run `kin doctor --fix`",
          }),
        ],
        healthy: false,
      })
    );
    expect(hasFixableChecks(report)).toBe(true);
  });

  it("does not offer doctor --fix once every fixable check is healthy", () => {
    const report = parseHealthReport(readyReport(MACOS));
    expect(hasFixableChecks(report)).toBe(false);
  });

  it("keeps a repo_init manual-fix command available for the terminal/copy affordance", () => {
    const repoInit = parseHealthReport(freshMachineReport(LINUX)).checks.find((c) => c.id === "repo_init")!;
    expect(repoInit.manual_fix).toBe("run `kin init .` to initialize a repository here");
  });
});

describe("first-run matrix — status-bar copy", () => {
  it("shows the entity count once the graph is initialised", () => {
    expect(
      formatStatusBarText({ initialized: true, entityCount: 128, graphState: "ready" })
    ).toBe("$(graph) Kin: 128 entities");
    expect(
      formatStatusBarTooltip({ initialized: true, entityCount: 128, graphState: "ready" })
    ).toContain("128 entities indexed");
  });

  it("shows an honest not-initialised state on a fresh workspace", () => {
    expect(
      formatStatusBarText({ initialized: false, entityCount: 0, graphState: "unknown" })
    ).toBe("$(graph) Kin: not initialized");
    expect(
      formatStatusBarTooltip({ initialized: false, entityCount: 0, graphState: "unknown" })
    ).toMatch(/not initialized yet/i);
  });
});

describe("first-run matrix — overview / graph-state copy", () => {
  it("never presents fabricated zeros when the graph is not indexed yet", () => {
    const msg = formatOverviewMessage({
      entities: 0,
      edges: 0,
      files: 0,
      kinds: {},
      indexed: false,
      availability: "not-indexed",
      compatFallback: false,
    });
    expect(msg).not.toContain("Entities: 0");
    expect(msg).toMatch(/not indexed/i);
  });

  it("distinguishes a reachable-but-empty graph from a not-indexed one", () => {
    const msg = formatOverviewMessage({
      entities: 0,
      edges: 0,
      files: 0,
      kinds: {},
      indexed: false,
      availability: "empty",
      compatFallback: false,
    });
    expect(msg).not.toContain("Entities: 0");
    expect(msg).toMatch(/no entities/i);
  });

  it("renders real counts once the graph is populated", () => {
    const msg = formatOverviewMessage({
      entities: 10,
      edges: 7,
      files: 4,
      kinds: { Function: 6, Class: 4 },
      indexed: true,
      availability: "indexed",
      compatFallback: false,
    });
    expect(msg).toBe("Entities: 10 | Edges: 7 | Files: 4 | Kinds: Function(6), Class(4)");
  });
});

describe("first-run matrix — error / recovery copy", () => {
  it("tells the user how to recover when the kin binary is missing", () => {
    expect(describeError(new BinaryNotFoundError())).toBe(
      "Kin binary not found. Install kin or set kin.binaryPath in settings."
    );
    expect(describeError(new BinaryNotFoundError("/opt/kin/bin/kin"))).toBe(
      "Kin binary not found at: /opt/kin/bin/kin"
    );
  });

  it("names the command and timeout when a call times out", () => {
    expect(describeError(new TimeoutError("search foo", 15000))).toBe(
      "Kin command timed out after 15000ms: search foo"
    );
  });

  it("names the command when a response cannot be parsed", () => {
    expect(describeError(new ParseError("setup status", "<html>"))).toMatch(
      /Failed to parse JSON response from kin setup status/
    );
  });
});

describe("first-run matrix — runSetupStatus against the released CLI path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false); // no configured binary; resolve bare `kin` on PATH
  });

  it("surfaces a BinaryNotFoundError (not a fabricated green) when kin is not installed", async () => {
    mockExecFile.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        const err = new Error("spawn kin ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        cb(err, "", "");
      }
    );
    await expect(runSetupStatus("/workspace")).rejects.toThrow(BinaryNotFoundError);
  });

  it("parses a real fresh-machine report from stdout", async () => {
    mockExecFile.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        cb(null, freshMachineReport(MACOS), "");
      }
    );
    const report = await runSetupStatus("/workspace");
    expect(report.platform).toBe("macos");
    expect(report.healthy).toBe(false);
    expect(report.checks.find((c) => c.id === "repo_init")!.status).toBe("missing");
  });

  it("still returns the report when the CLI exits non-zero but emits valid JSON on stdout", async () => {
    mockExecFile.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        cb(new Error("exit 1"), readyReport(WINDOWS), "");
      }
    );
    const report = await runSetupStatus("/workspace");
    expect(report.platform).toBe("windows");
    expect(report.healthy).toBe(true);
  });
});
