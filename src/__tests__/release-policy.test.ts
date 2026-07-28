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
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");

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

describe("release-policy release-needed", () => {
  it("selects release-impacting drift", () => {
    const { status, stdout } = runPolicy([
      "release-needed",
      "--changed-files",
      "README.md,.github/workflows/ci.yml",
      "--old-version",
      "0.1.1",
      "--new-version",
      "0.1.1",
      "--json",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      needed: true,
      releaseImpacting: ["README.md"],
    });
  });

  it("does not release dependency and workflow hygiene", () => {
    const { status, stdout } = runPolicy([
      "release-needed",
      "--changed-files",
      "package.json,package-lock.json,.github/workflows/ci.yml",
      "--old-version",
      "0.1.1",
      "--new-version",
      "0.1.1",
      "--json",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      needed: false,
      releaseImpacting: [],
    });
  });

  it("fails closed when release drift cannot be resolved", () => {
    const { status, stderr } = runPolicy(["release-needed"]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/could not resolve release drift/);
  });
});

describe("automatic release workflow authority", () => {
  it("keeps the coalescing writer Contents-only across workflow drift", () => {
    const train = readFileSync(join(WORKFLOWS, "release-train.yml"), "utf8");
    expect(train).toContain("environment: release-tag");
    expect(train).toContain('"repos/${GITHUB_REPOSITORY}/merges"');
    expect(train).toContain('"repos/${GITHUB_REPOSITORY}/git/refs"');
    expect(train).toContain("git merge-base --is-ancestor");
    expect(train).toContain("Neutralize generated release bytes");
    expect(train).toContain("Signed-off-by: kin-release-bot[bot]");
    expect(train).toContain("--match-head-commit");
    expect(train).not.toContain("workflow_dispatch:");
    expect(train).not.toContain("workflows: write");
    expect(train).not.toMatch(/\bgit merge(?:\s|\\)/);
    expect(train).not.toMatch(/git push (?:--force|-f)\b/);
    expect(train).not.toMatch(/git push origin :/);
  });

  it("tags only exact required-check-green main through the release environment", () => {
    const tag = readFileSync(join(WORKFLOWS, "release-tag.yml"), "utf8");
    expect(tag).toContain("environment: release-tag");
    expect(tag).toContain("repositories: kin-editor");
    expect(tag).toContain("commits/${main_sha}/check-runs");
    expect(tag).toContain("for required in test release-policy");
    expect(tag).toContain('"repos/${REPO}/git/tags"');
    expect(tag).toContain('"repos/${REPO}/git/refs"');
    expect(tag).not.toContain("workflow_dispatch:");
    expect(tag).not.toContain("contents: write");
  });

  it("bounds automatic release retries to two reruns", () => {
    const recovery = readFileSync(
      join(WORKFLOWS, "release-recovery.yml"),
      "utf8",
    );
    expect(recovery).toContain("github.event.workflow_run.run_attempt < 3");
    expect(recovery).toContain("rerun-failed-jobs");
    expect(recovery).toContain('.path <<< "$run")" = ".github/workflows/release.yml"');
    expect(recovery).not.toContain("workflow_dispatch:");
  });

  it("exposes Marketplace credentials only on the protected publish job", () => {
    const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
    expect(release).toMatch(/permissions:\n {2}contents: read/);
    expect(release).toContain("environment: marketplace-publish");
    expect(release).toMatch(
      /release:[\s\S]*permissions:\n {6}contents: write/,
    );
  });
});
