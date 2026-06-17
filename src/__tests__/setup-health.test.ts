// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { ParseError } from "../errors";

jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: () => ({ get: () => "" }),
    },
  }),
  { virtual: true }
);

jest.mock("fs");

import {
  HealthReport,
  hasFixableChecks,
  isFailing,
  parseHealthReport,
} from "../setup-health";

// Mirrors the real `kin setup status --json` output: serde's pretty-printed
// HealthReport { platform, checks: [{ id, label, status, detail,
// platform_note, fixable, manual_fix }], healthy }.
const FIXTURE = JSON.stringify({
  platform: "macos",
  checks: [
    {
      id: "kin_binary",
      label: "Kin CLI",
      status: "healthy",
      detail: "kin 0.1.0 on PATH",
      platform_note: null,
      fixable: false,
      manual_fix: null,
    },
    {
      id: "repo_init",
      label: "Repository initialized",
      status: "missing",
      detail: "no .kin/ directory here",
      platform_note: null,
      fixable: false,
      manual_fix: "run `kin init .` to initialize a repository here",
    },
    {
      id: "vfs_projection",
      label: "VFS projection",
      status: "unsupported",
      detail: "ProjFS not available",
      platform_note: "Windows VFS projection requires ProjFS",
      fixable: false,
      manual_fix: "enable the Projected File System Windows feature",
    },
    {
      id: "mcp_client_claude",
      label: "MCP: Claude Code",
      status: "misconfigured",
      detail: "mcpServers.kin present but profile wrong",
      platform_note: null,
      fixable: true,
      manual_fix: "run `kin doctor --fix`",
    },
    {
      id: "editor",
      label: "Editor integration",
      status: "healthy",
      detail: "kin-editor extension active",
      platform_note: null,
      fixable: false,
      manual_fix: null,
    },
  ],
  healthy: false,
});

describe("parseHealthReport", () => {
  it("parses the real serde HealthReport shape", () => {
    const report = parseHealthReport(FIXTURE);
    expect(report.platform).toBe("macos");
    expect(report.healthy).toBe(false);
    expect(report.checks).toHaveLength(5);

    const binary = report.checks[0];
    expect(binary.id).toBe("kin_binary");
    expect(binary.status).toBe("healthy");
    expect(binary.fixable).toBe(false);
    expect(binary.manual_fix).toBeNull();
  });

  it("preserves platform_note and manual_fix when present", () => {
    const report = parseHealthReport(FIXTURE);
    const vfs = report.checks.find((c) => c.id === "vfs_projection")!;
    expect(vfs.status).toBe("unsupported");
    expect(vfs.platform_note).toBe(
      "Windows VFS projection requires ProjFS"
    );
    const repo = report.checks.find((c) => c.id === "repo_init")!;
    expect(repo.manual_fix).toBe(
      "run `kin init .` to initialize a repository here"
    );
  });

  it("never fabricates a passing check — unknown status falls back to missing", () => {
    const raw = JSON.stringify({
      platform: "linux",
      checks: [
        { id: "x", label: "X", status: "bananas", detail: "", fixable: false },
      ],
      healthy: true,
    });
    const report = parseHealthReport(raw);
    expect(report.checks[0].status).toBe("missing");
  });

  it("throws ParseError on non-JSON output", () => {
    expect(() => parseHealthReport("not json {{{")).toThrow(ParseError);
  });

  it("throws ParseError when 'checks' is missing", () => {
    expect(() => parseHealthReport(JSON.stringify({ platform: "x" }))).toThrow(
      ParseError
    );
  });

  it("derives healthy from checks when the field is absent", () => {
    const raw = JSON.stringify({
      platform: "linux",
      checks: [
        { id: "a", label: "A", status: "healthy", detail: "" },
        { id: "b", label: "B", status: "stale", detail: "" },
      ],
    });
    const report = parseHealthReport(raw);
    // stale does not fail the overall report
    expect(report.healthy).toBe(true);
  });
});

describe("isFailing", () => {
  it("treats missing and misconfigured as failing", () => {
    expect(isFailing("missing")).toBe(true);
    expect(isFailing("misconfigured")).toBe(true);
  });

  it("does not treat stale or unsupported as failing", () => {
    expect(isFailing("healthy")).toBe(false);
    expect(isFailing("stale")).toBe(false);
    expect(isFailing("unsupported")).toBe(false);
  });
});

describe("hasFixableChecks", () => {
  it("is true when a non-healthy check is fixable", () => {
    const report: HealthReport = parseHealthReport(FIXTURE);
    expect(hasFixableChecks(report)).toBe(true);
  });

  it("is false when every fixable check is already healthy", () => {
    const report: HealthReport = {
      platform: "macos",
      healthy: true,
      checks: [
        {
          id: "a",
          label: "A",
          status: "healthy",
          detail: "",
          platform_note: null,
          fixable: true,
          manual_fix: null,
        },
      ],
    };
    expect(hasFixableChecks(report)).toBe(false);
  });
});
