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

function tempVersionAuthorities(version: string): {
  policy: string;
  packageJson: string;
  mcpClient: string;
} {
  const original = readFileSync(join(REPO_ROOT, "release.toml"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "kin-editor-compat-"));
  const packageJson = join(dir, "package.json");
  const mcpClient = join(dir, "mcp-client.ts");
  const policy = join(dir, "release.toml");
  writeFileSync(
    packageJson,
    `${JSON.stringify({ name: "kin-editor", version }, null, 2)}\n`,
  );
  writeFileSync(
    mcpClient,
    `this.sendRequest(
  "initialize",
  {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "kin-editor",
      version: "${version}",
    },
  },
);
`,
  );
  writeFileSync(
    policy,
    original.replace('file = "package.json"', `file = "${packageJson}"`),
  );
  tempFiles.push(dir);
  return { policy, packageJson, mcpClient };
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

  it("fails when MCP clientInfo.version cannot be source-checked", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "mcp-client.ts"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "kin-editor-mcp-version-"));
    const mcpClient = join(dir, "mcp-client.ts");
    writeFileSync(
      mcpClient,
      source.replace(/\n\s*version:\s*"[^"]+",/, ""),
    );
    tempFiles.push(dir);

    const { status, stdout } = runPolicy([
      "verify",
      "--mcp-client",
      mcpClient,
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(
      /could not read clientInfo\.version/,
    );
  });

  it("does not borrow a later decoy version when handshake authority is missing", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "mcp-client.ts"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "kin-editor-mcp-decoy-"));
    const mcpClient = join(dir, "mcp-client.ts");
    writeFileSync(
      mcpClient,
      `${source.replace(/\n\s*version:\s*"[^"]+",/, "")}\nconst unrelated = { version: "0.1.1" };\n`,
    );
    tempFiles.push(dir);

    const { status, stdout } = runPolicy([
      "verify",
      "--mcp-client",
      mcpClient,
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(
      /could not read clientInfo\.version/,
    );
  });

  it("fails when a proof-impacting surface no longer exists", () => {
    const badToml = tempReleaseToml((t) =>
      t.replace('"src/mcp-client.ts",', '"src/does-not-exist.ts",')
    );
    const { status, stdout } = runPolicy(["verify", "--file", badToml, "--json"]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(/does-not-exist\.ts/);
  });

  it("fails when the package version is outside every compatibility row", () => {
    const fixture = tempVersionAuthorities("0.2.0");
    const { status, stdout } = runPolicy([
      "verify",
      "--file",
      fixture.policy,
      "--package",
      fixture.packageJson,
      "--mcp-client",
      fixture.mcpClient,
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(
      /outside every compatibility\.matrix extension range/,
    );
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

  it("allows an exact successor carried by the protected generated release branch", () => {
    const { status, stdout } = runPolicy([
      "check-bump",
      "--changed-files",
      "src/mcp-client.ts,package.json,package-lock.json,CHANGELOG.md",
      "--old-version",
      "0.1.0",
      "--new-version",
      "0.1.1",
      "--head-ref",
      "automation/release-next",
      "--head-repo",
      "firelock-ai/kin-editor",
      "--base-repo",
      "firelock-ai/kin-editor",
      "--json",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).versionChanged).toBe(true);
  });

  it.each([
    ["0.1.1", "0.0.1", "strictly forward"],
    ["0.1.1", "beta", "exact stable SemVer"],
    ["0.1.1", "999.0.0", "not an exact patch, minor, or major successor"],
  ])("rejects unsafe version authority %s -> %s", (oldVersion, newVersion, reason) => {
    const { status, stdout } = runPolicy([
      "check-bump",
      "--changed-files",
      "src/mcp-client.ts,package.json,package-lock.json,CHANGELOG.md",
      "--old-version",
      oldVersion,
      "--new-version",
      newVersion,
      "--head-ref",
      "automation/release-next",
      "--head-repo",
      "firelock-ai/kin-editor",
      "--base-repo",
      "firelock-ai/kin-editor",
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(new RegExp(reason));
  });

  it("rejects version changes outside the first-party protected train", () => {
    const { status, stdout } = runPolicy([
      "check-bump",
      "--changed-files",
      "src/mcp-client.ts,package.json,package-lock.json,CHANGELOG.md",
      "--old-version",
      "0.1.1",
      "--new-version",
      "0.1.2",
      "--head-ref",
      "feature/manual-version",
      "--head-repo",
      "firelock-ai/kin-editor",
      "--base-repo",
      "firelock-ai/kin-editor",
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(
      /version authority belongs only/,
    );
  });

  it("rejects non-generated paths in the protected train", () => {
    const { status, stdout } = runPolicy([
      "check-bump",
      "--changed-files",
      "src/extension.ts,src/mcp-client.ts,package.json,package-lock.json,CHANGELOG.md",
      "--old-version",
      "0.1.1",
      "--new-version",
      "0.1.2",
      "--head-ref",
      "automation/release-next",
      "--head-repo",
      "firelock-ai/kin-editor",
      "--base-repo",
      "firelock-ai/kin-editor",
      "--json",
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).failures.join("\n")).toMatch(/non-generated paths/);
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
    expect(train).toContain("permission-contents: write");
    expect(train).toContain("permission-pull-requests: write");
    expect(train).toContain("GH_TOKEN: ${{ steps.app-token.outputs.token }}");
    expect(train).toContain("Install trusted release-policy dependencies");
    expect(train).toContain("run: npm ci");
    expect(train).toContain("scripts/mcp-version-authority.mjs");
    expect(train).not.toContain('scripts/release-policy.mjs; do');
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
    expect(tag).toContain(".app.id == 15368");
    expect(tag).toContain('.app.slug == "github-actions"');
    expect(tag).toContain("permission-contents: write");
    expect(tag).toContain("release-train reconciliation owns current main drift");
    expect(tag).toContain('"repos/${REPO}/git/tags"');
    expect(tag).toContain('"repos/${REPO}/git/refs"');
    expect(tag).not.toContain("workflow_dispatch:");
    expect(tag).toMatch(/permissions:\n {2}checks: read\n {2}contents: read/);
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
