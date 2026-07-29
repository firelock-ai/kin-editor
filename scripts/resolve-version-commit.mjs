#!/usr/bin/env node

// Resolve the oldest commit in protected main's contiguous suffix carrying a
// version. Later main drift must never be silently included in an earlier tag.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument sequence near ${key}`);
    }
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

function git(args, { root = process.cwd(), check = true } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (check && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function versionAt(root, ref) {
  const result = git(["show", `${ref}:package.json`], { root, check: false });
  if (result.status !== 0) return null;
  let version;
  try {
    version = JSON.parse(result.stdout).version;
  } catch {
    throw new Error(`package.json at ${ref} is not valid JSON`);
  }
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`package.json at ${ref} has no exact stable SemVer`);
  }
  return version;
}

export function resolveVersionCommit({
  root = process.cwd(),
  headRef = "HEAD",
  targetVersion,
}) {
  if (!SEMVER.test(targetVersion ?? "")) {
    throw new Error("target version must be an exact stable SemVer");
  }
  const commits = git(["rev-list", "--first-parent", headRef], { root })
    .stdout.split("\n")
    .map((commit) => commit.trim())
    .filter(Boolean);
  if (commits.length === 0 || commits.some((commit) => !SHA.test(commit))) {
    throw new Error(`could not resolve exact first-parent history from ${headRef}`);
  }

  let introduced = null;
  for (const [index, commit] of commits.entries()) {
    const version = versionAt(root, commit);
    if (version !== targetVersion) {
      if (index === 0) {
        throw new Error(
          `${headRef} carries version ${version ?? "unreadable"}, expected ${targetVersion}`,
        );
      }
      break;
    }
    introduced = commit;
  }
  if (introduced === null) {
    throw new Error(`no first-parent commit introduces version ${targetVersion}`);
  }
  return { headRef, version: targetVersion, commit: introduced };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetVersion = args.get("target-version");
  const headRef = args.get("head-ref") ?? "HEAD";
  if (!targetVersion) throw new Error("--target-version is required");
  process.stdout.write(
    `${JSON.stringify(resolveVersionCommit({ headRef, targetVersion }))}\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(process.argv[1]);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`resolve-version-commit: ${error.message}\n`);
    process.exitCode = 1;
  }
}
