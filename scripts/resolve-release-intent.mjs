#!/usr/bin/env node

// Resolve automatic release intent only from immutable first-parent commits.
// Mutable pull-request labels and dispatch payloads are deliberately ignored.

import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TRAILER_KEY = "Kin-Release-Intent";
const INTENTS = ["patch", "minor", "major"];
const RANK = new Map(INTENTS.map((intent, index) => [intent, index]));
const RAW_TRAILER_RE =
  /^[ \t]*Kin-Release-Intent\b[^\r\n]*$/gim;
const PARSED_TRAILER_RE =
  /^Kin-Release-Intent:\s*(\S+)\s*$/i;

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

function git(args, options = {}) {
  return execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: options.root,
    encoding: "utf8",
    input: options.input,
  });
}

function commitIntent(root, commit) {
  const message = git(["show", "-s", "--format=%B", commit], { root });
  const rawMentions = message.match(RAW_TRAILER_RE) ?? [];
  const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
    cwd: root,
    encoding: "utf8",
    input: message,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsedIntents = parsed.flatMap((line) => {
    const match = PARSED_TRAILER_RE.exec(line);
    return match ? [match[1].toLowerCase()] : [];
  });

  if (rawMentions.length !== parsedIntents.length) {
    throw new Error(
      `${commit} has malformed or non-footer ${TRAILER_KEY} evidence`,
    );
  }
  if (parsedIntents.length > 1) {
    throw new Error(`${commit} has duplicate ${TRAILER_KEY} trailers`);
  }
  if (parsedIntents.length === 0) return null;

  const intent = parsedIntents[0];
  if (!RANK.has(intent)) {
    throw new Error(`${commit} has invalid ${TRAILER_KEY}: ${intent}`);
  }
  return intent;
}

export function resolveReleaseIntent({
  root = process.cwd(),
  baseRef,
  headRef = "HEAD",
}) {
  const ancestor = spawnSync(
    "git",
    ["--no-replace-objects", "merge-base", "--is-ancestor", baseRef, headRef],
    { cwd: root, encoding: "utf8" },
  );
  if (ancestor.status !== 0) {
    throw new Error(`${baseRef} is not an ancestor of ${headRef}`);
  }

  const commits = git(
    ["rev-list", "--first-parent", "--reverse", `${baseRef}..${headRef}`],
    { root },
  )
    .split("\n")
    .map((commit) => commit.trim())
    .filter(Boolean);

  const evidence = [];
  let intent = "patch";
  for (const commit of commits) {
    const found = commitIntent(root, commit);
    if (found === null) continue;
    evidence.push({ commit, intent: found });
    if (RANK.get(found) > RANK.get(intent)) intent = found;
  }
  return { baseRef, headRef, intent, evidence };
}

function appendOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `intent=${result.intent}`,
      `evidence_json=${JSON.stringify(result.evidence)}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRef = args.get("base-ref");
  const headRef = args.get("head-ref") ?? "HEAD";
  if (!baseRef) throw new Error("--base-ref is required");
  const result = resolveReleaseIntent({ baseRef, headRef });
  appendOutputs(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(process.argv[1]);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`resolve-release-intent: ${error.message}\n`);
    process.exitCode = 1;
  }
}
