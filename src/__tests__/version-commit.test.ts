// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  cpSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "resolve-version-commit.mjs");
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function writeVersion(dir: string, version: string): void {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "kin-editor", version }, null, 2)}\n`,
  );
}

function commit(dir: string, message: string): string {
  git(dir, "add", ".");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "kin-editor-version-"));
  tempDirs.push(dir);
  cpSync(SCRIPT, join(dir, "resolve-version-commit.mjs"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Kin Test");
  git(dir, "config", "user.email", "kin-test@example.invalid");
  git(dir, "config", "core.hooksPath", "/dev/null");
  writeVersion(dir, "0.1.1");
  commit(dir, "Base");
  return dir;
}

function resolveCommit(dir: string, version: string) {
  return spawnSync(
    process.execPath,
    [
      join(dir, "resolve-version-commit.mjs"),
      "--head-ref",
      "HEAD",
      "--target-version",
      version,
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("version-introducing commit", () => {
  it("excludes later higher-intent main drift from the prepared tag", () => {
    const dir = fixture();
    writeVersion(dir, "0.2.0");
    const release = commit(dir, "Release minor");
    writeFileSync(join(dir, "breaking.ts"), "breaking\n");
    commit(dir, "Later breaking work\n\nKin-Release-Intent: major");

    const result = resolveCommit(dir, "0.2.0");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "0.2.0",
      commit: release,
    });
  });

  it("starts a new suffix at every version transition", () => {
    const dir = fixture();
    writeVersion(dir, "0.1.2");
    commit(dir, "Patch");
    writeVersion(dir, "0.2.0");
    const release = commit(dir, "Minor");
    writeFileSync(join(dir, "later"), "later\n");
    commit(dir, "Later");
    expect(JSON.parse(resolveCommit(dir, "0.2.0").stdout).commit).toBe(release);
  });

  it("fails closed when head does not carry the target version", () => {
    const dir = fixture();
    const result = resolveCommit(dir, "0.2.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/carries version 0\.1\.1/);
  });
});
