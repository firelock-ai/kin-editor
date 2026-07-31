#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { replaceMcpClientVersion } from "./mcp-version-authority.mjs";

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

function parseVersion(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`${label} must be an exact stable SemVer`);
  return match.slice(1).map(Number);
}

function nextVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version, "base version");
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unsupported release bump: ${bump}`);
  }
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitShow(ref, path) {
  return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
}

function sourceVersion(ref) {
  return JSON.parse(gitShow(ref, "package.json")).version;
}

function releaseSubjects(baseTag, sourceRef) {
  const output = execFileSync(
    "git",
    ["log", "--first-parent", "--format=%s", `${baseTag}..${sourceRef}`],
    { encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => !/^Release Kin Editor v?\d+\.\d+\.\d+$/.test(subject));
}

function prependChangelog(changelog, version, subjects, date) {
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already contains ${version}`);
  }
  if (subjects.length === 0) {
    throw new Error("release range contains no first-parent commits");
  }
  const marker =
    "All notable changes to the Kin VS Code extension are documented in this file.\n";
  if (!changelog.includes(marker)) {
    throw new Error("CHANGELOG.md introduction marker is missing");
  }
  const bullets = subjects.map((subject) => `- ${subject}`).join("\n");
  const entry = `\n## [${version}] - ${date}\n\n### Changed\n\n${bullets}\n`;
  return changelog.replace(marker, `${marker}${entry}`);
}

function appendOutput(path, values) {
  if (!path) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.appendFileSync(path, `${lines}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseTag = opts.get("base-tag");
  const bump = opts.get("bump");
  const sourceRef = opts.get("source-ref");
  if (!baseTag || !bump || !sourceRef) {
    throw new Error("--base-tag, --bump, and --source-ref are required");
  }
  if (!baseTag.startsWith("v")) throw new Error("base tag must start with v");

  const baseVersion = baseTag.slice(1);
  parseVersion(baseVersion, "base tag");
  const trustedVersion = sourceVersion(sourceRef);
  if (trustedVersion !== baseVersion) {
    throw new Error(
      `trusted source version ${trustedVersion} does not match base tag ${baseTag}`,
    );
  }

  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  if (pkg.version !== baseVersion) {
    throw new Error(`working package version ${pkg.version} does not match ${baseTag}`);
  }
  if (lock.version !== baseVersion || lock.packages?.[""]?.version !== baseVersion) {
    throw new Error("package-lock root versions do not match the base tag");
  }

  const version = nextVersion(baseVersion, bump);
  const tag = `v${version}`;
  const subjects = releaseSubjects(baseTag, sourceRef);
  const date = new Date().toISOString().slice(0, 10);

  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  writeJson("package.json", pkg);
  writeJson("package-lock.json", lock);

  const clientPath = "src/mcp-client.ts";
  fs.writeFileSync(
    clientPath,
    replaceMcpClientVersion(
      fs.readFileSync(clientPath, "utf8"),
      baseVersion,
      version,
    ),
  );
  fs.writeFileSync(
    "CHANGELOG.md",
    prependChangelog(
      fs.readFileSync("CHANGELOG.md", "utf8"),
      version,
      subjects,
      date,
    ),
  );

  appendOutput(process.env.GITHUB_OUTPUT, {
    version,
    tag,
    base_version: baseVersion,
    commit_count: subjects.length,
  });
  console.log(`Prepared Kin Editor ${tag} from ${subjects.length} first-parent commits.`);
}

try {
  main();
} catch (error) {
  console.error(`prepare-release: ${error.message}`);
  process.exitCode = 1;
}
