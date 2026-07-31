// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "resolve-release-intent.mjs");
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function fixture(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "kin-editor-intent-"));
  tempDirs.push(dir);
  cpSync(SCRIPT, join(dir, "resolve-release-intent.mjs"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Kin Test");
  git(dir, "config", "user.email", "kin-test@example.invalid");
  git(dir, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "source"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "Base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function change(dir: string, value: string, message: string): string {
  writeFileSync(join(dir, "source"), `${value}\n`);
  git(dir, "add", "source");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

function resolveIntent(dir: string, base: string) {
  return spawnSync(
    process.execPath,
    [
      join(dir, "resolve-release-intent.mjs"),
      "--base-ref",
      base,
      "--head-ref",
      "HEAD",
    ],
    { cwd: dir, encoding: "utf8" },
  );
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("immutable release intent", () => {
  it("is the sole automatic intent authority in the release train", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "release-train.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "node scripts/resolve-release-intent.mjs",
    );
    expect(workflow).not.toContain("OVERRIDE_BUMP");
    expect(workflow).not.toContain("/commits/${commit}/pulls");
    expect(workflow).not.toContain("train_labels");
    expect(workflow).toContain("Labels are descriptive only.");
  });

  it("defaults source drift to patch", () => {
    const { dir, base } = fixture();
    change(dir, "one", "Ordinary source");
    const result = resolveIntent(dir, base);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).intent).toBe("patch");
  });

  it("selects the highest landed first-parent trailer", () => {
    const { dir, base } = fixture();
    const minor = change(
      dir,
      "one",
      "Feature\n\nKin-Release-Intent: minor",
    );
    const major = change(
      dir,
      "two",
      "Breaking\n\nKin-Release-Intent: major",
    );
    const result = resolveIntent(dir, base);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      intent: "major",
      evidence: [
        { commit: minor, intent: "minor" },
        { commit: major, intent: "major" },
      ],
    });
  });

  it.each([
    "Bad\n\nKin-Release-Intent: minor\nKin-Release-Intent: major",
    "Bad\n\nKin-Release-Intent: banana",
    "Kin-Release-Intent: minor\n\nBody after trailer",
  ])("fails closed for malformed evidence: %s", (message) => {
    const { dir, base } = fixture();
    change(dir, "bad", message);
    const result = resolveIntent(dir, base);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/resolve-release-intent:/);
  });

  it("ignores mutable PR metadata because no API input exists", () => {
    const { dir, base } = fixture();
    change(dir, "one", "Ordinary source");
    const result = spawnSync(
      process.execPath,
      [
        join(dir, "resolve-release-intent.mjs"),
        "--base-ref",
        base,
        "--head-ref",
        "HEAD",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          OVERRIDE_BUMP: "major",
          PR_LABELS: "release:major",
        },
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).intent).toBe("patch");
  });
});
