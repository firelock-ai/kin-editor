// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "prepare-release.mjs");
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "kin-editor-release-"));
  tempDirs.push(dir);
  cpSync(SCRIPT, join(dir, "prepare-release.mjs"));
  chmodSync(join(dir, "prepare-release.mjs"), 0o755);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "kin-editor", version: "0.1.1" }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify({
      name: "kin-editor",
      version: "0.1.1",
      lockfileVersion: 3,
      packages: { "": { name: "kin-editor", version: "0.1.1" } },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\nAll notable changes to the Kin VS Code extension are documented in this file.\n",
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "mcp-client.ts"),
    'clientInfo: {\n  name: "kin-editor",\n  version: "0.1.1",\n},\n',
  );
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Kin Test");
  git(dir, "config", "user.email", "kin-test@example.com");
  git(dir, "add", ".");
  git(dir, "commit", "-sqm", "Initial editor release");
  git(dir, "tag", "v0.1.1");
  writeFileSync(join(dir, "README.md"), "release-impacting copy\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-sqm", "Improve first-run guidance");
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("prepare-release", () => {
  it("bumps every version authority and generates notes", () => {
    const dir = fixture();
    const srcDir = join(dir, "src");

    const result = spawnSync(
      process.execPath,
      [
        join(dir, "prepare-release.mjs"),
        "--base-tag",
        "v0.1.1",
        "--bump",
        "patch",
        "--source-ref",
        "HEAD",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe(
      "0.1.2",
    );
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("0.1.2");
    expect(lock.packages[""].version).toBe("0.1.2");
    expect(readFileSync(join(srcDir, "mcp-client.ts"), "utf8")).toContain(
      'version: "0.1.2"',
    );
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toMatch(
      /## \[0\.1\.2\].*Improve first-run guidance/s,
    );
  });

  it("rejects a trusted source whose version is not the base tag", () => {
    const dir = fixture();
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.version = "0.2.0";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    git(dir, "add", "package.json");
    git(dir, "commit", "-sqm", "Move source version");

    const result = spawnSync(
      process.execPath,
      [
        join(dir, "prepare-release.mjs"),
        "--base-tag",
        "v0.1.1",
        "--bump",
        "patch",
        "--source-ref",
        "HEAD",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/trusted source version 0\.2\.0/);
  });
});
