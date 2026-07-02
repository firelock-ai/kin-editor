// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Exercises scripts/release-policy.mjs as a real subprocess against the actual
// release.toml / package.json / src/mcp-client.ts, so the release-graph gate is
// tested exactly as CI runs it: the metadata source-check, the dependency-only
// bump gate, and the proof-impacting surface report.

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release-policy.mjs");

jest.setTimeout(20_000);

function runPolicy(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const tempFiles: string[] = [];
function tempReleaseToml(transform: (text: string) => string): string {
  const original = readFileSync(join(REPO_ROOT, "release.toml"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "kin-editor-policy-"));
  const path = join(dir, "release.toml");
  writeFileSync(path, transform(original));
  tempFiles.push(dir);
  return path;
}

afterAll(() => {
  for (const dir of tempFiles) rmSync(dir, { recursive: true, force: true });
});

describe("release-policy verify", () => {
  it("passes against the real release.toml (metadata + source-check coherent)", () => {
    const { status, stdout } = runPolicy(["verify", "--json"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("fails when the declared MCP protocol does not match the handshake in src/mcp-client.ts", () => {
    const badToml = tempReleaseToml((t) =>
      t.split("2024-11-05").join("1999-01-01")
    );
    const { status, stdout } = runPolicy(["verify", "--file", badToml, "--json"]);
    expect(status).toBe(1);
    const failures = JSON.parse(stdout).failures.join("\n");
    expect(failures).toMatch(/mcp_protocol/);
  });

  it("fails when a proof-impacting surface no longer exists", () => {
    const badToml = tempReleaseToml((t) =>
      t.replace('"src/mcp-client.ts",', '"src/does-not-exist.ts",')
    );
    const { status, stdout } = runPolicy(["verify", "--file", badToml, "--json"]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(/does-not-exist\.ts/);
  });
});

describe("release-policy check-bump", () => {
  it("blocks a dependency-only bump that carries a version change", () => {
    const { status, stdout } = runPolicy([
      "check-bump",
      "--changed-files",
      "package.json,package-lock.json",
      "--old-version",
      "0.1.0",
      "--new-version",
      "0.1.1",
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(/must not auto-release/);
  });

  it("blocks a compat-record-only bump (release.toml) that carries a version change", () => {
    const { status } = runPolicy([
      "check-bump",
      "--changed-files",
      "release.toml",
      "--old-version",
      "0.1.0",
      "--new-version",
      "0.1.1",
      "--json",
    ]);
    expect(status).toBe(1);
  });

  it("allows a version bump that carries a real extension-source change", () => {
    const { status, stdout } = runPolicy([
      "check-bump",
      "--changed-files",
      "src/extension.ts,package.json",
      "--old-version",
      "0.1.0",
      "--new-version",
      "0.1.1",
      "--json",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).versionChanged).toBe(true);
  });

  it("allows a dependency-only change with no version bump (ordinary hygiene)", () => {
    const { status } = runPolicy([
      "check-bump",
      "--changed-files",
      "package.json,package-lock.json",
      "--old-version",
      "0.1.0",
      "--new-version",
      "0.1.0",
      "--json",
    ]);
    expect(status).toBe(0);
  });

  it("fails open (exit 0) when the change set cannot be resolved", () => {
    const { status, stdout } = runPolicy(["check-bump"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/skipping the bump gate/);
  });
});

describe("release-policy proof-impact", () => {
  it("reports proof-impacting surfaces that changed", () => {
    const { status, stdout } = runPolicy([
      "proof-impact",
      "--changed-files",
      "src/mcp-client.ts,src/logger.ts",
      "--json",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).proofImpacting).toEqual(["src/mcp-client.ts"]);
  });

  it("reports nothing when no proof surface changed", () => {
    const { stdout } = runPolicy([
      "proof-impact",
      "--changed-files",
      "src/logger.ts",
      "--json",
    ]);
    expect(JSON.parse(stdout).proofImpacting).toEqual([]);
  });
});
