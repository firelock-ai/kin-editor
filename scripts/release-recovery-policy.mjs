// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import process from "node:process";
import { pathToFileURL } from "node:url";

const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "startup_failure",
  "timed_out",
]);
const STABLE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TERMINAL_LABEL = "release:terminal-failure";

function fail(message) {
  throw new Error(`release recovery policy: ${message}`);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

function expectedRunUrl(repository, runId) {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

export function classifyReleaseRun(run, expectedRepository) {
  if (typeof run !== "object" || run === null || Array.isArray(run)) {
    fail("run must be an object");
  }
  if (!REPOSITORY.test(expectedRepository ?? "")) {
    fail("expected repository must be owner/name");
  }

  const repository = requireString(
    run.repository?.full_name,
    "run.repository.full_name",
  );
  const headRepository = requireString(
    run.head_repository?.full_name,
    "run.head_repository.full_name",
  );
  if (repository !== expectedRepository || headRepository !== expectedRepository) {
    fail("run and head repositories must match the expected repository");
  }
  if (run.path !== RELEASE_WORKFLOW) {
    fail(`run path must be ${RELEASE_WORKFLOW}`);
  }
  if (run.event !== "push") {
    fail("run event must be push");
  }
  if (run.status !== "completed") {
    fail("run status must be completed");
  }
  if (!FAILED_CONCLUSIONS.has(run.conclusion)) {
    fail("run conclusion is not an admitted terminal failure");
  }

  const tag = requireString(run.head_branch, "run.head_branch");
  if (!STABLE_TAG.test(tag)) {
    fail("run head branch must be a stable vSemVer tag");
  }
  const headSha = requireString(run.head_sha, "run.head_sha");
  if (!SHA.test(headSha)) {
    fail("run head SHA must be 40 lowercase hexadecimal characters");
  }
  const runId = requirePositiveInteger(run.id, "run.id");
  const runAttempt = requirePositiveInteger(run.run_attempt, "run.run_attempt");
  const runUrl = requireString(run.html_url, "run.html_url");
  if (runUrl !== expectedRunUrl(repository, runId)) {
    fail("run URL does not match the exact repository and run id");
  }

  return {
    repository,
    runId,
    runAttempt,
    runUrl,
    tag,
    headSha,
    conclusion: run.conclusion,
    action: runAttempt < 3 ? "retry" : "escalate",
  };
}

export function terminalIssueFor(context) {
  if (context.action !== "escalate") {
    fail("terminal issue may be built only for an escalation");
  }
  const identity = `${context.repository}:${context.tag}`;
  const marker = `<!-- kin-editor-release-failure:${identity} -->`;
  const title = `[release failure] Kin Editor ${context.tag} exhausted automatic retries`;
  const body = `${marker}
## Terminal automatic release failure

Kin Editor's two bounded automatic reruns are exhausted. Successful releases
remain unattended; this issue records the exact terminal failure for diagnosis.

- Tag: \`${context.tag}\`
- Head commit: \`${context.headSha}\`
- Failed run: [${context.runId}](${context.runUrl})
- Run attempt: \`${context.runAttempt}\`
- Conclusion: \`${context.conclusion}\`
- Automatic reruns exhausted: \`2\`

Re-running or receiving another terminal event for this immutable tag updates
this same issue rather than creating another escalation.
`;
  return {
    identity,
    marker,
    title,
    body,
    label: TERMINAL_LABEL,
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    args.set(key.slice(2), value);
  }
  return args;
}

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  try {
    return JSON.parse(body);
  } catch {
    fail("stdin must contain one JSON run object");
  }
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  const repository = args.get("repository");
  const context = classifyReleaseRun(await readStdin(), repository);

  if (command === "validate") {
    const expected = args.get("expect");
    if (expected !== "retry" && expected !== "escalate") {
      fail("--expect must be retry or escalate");
    }
    if (context.action !== expected) {
      fail(`run requires ${context.action}, not ${expected}`);
    }
    process.stdout.write(`${JSON.stringify(context)}\n`);
    return;
  }
  if (command === "issue") {
    process.stdout.write(`${JSON.stringify(terminalIssueFor(context))}\n`);
    return;
  }
  fail("command must be validate or issue");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
