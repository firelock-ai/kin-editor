#!/usr/bin/env node

// Classify ordinary CI for the exact generated release-PR head. Terminal
// failures receive two bounded reruns, then one marker-keyed issue.

import process from "node:process";
import { pathToFileURL } from "node:url";

const CI_WORKFLOW = ".github/workflows/ci.yml";
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RETRYABLE = new Set([
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);

function fail(message) {
  throw new Error(`release train CI policy: ${message}`);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
}

export function classifyTrainCi(
  payload,
  { repository, headSha, headBranch },
) {
  if (!REPOSITORY.test(repository ?? "")) fail("repository must be owner/name");
  if (!SHA.test(headSha ?? "")) fail("head SHA must be exact");
  if (typeof headBranch !== "string" || headBranch.length === 0) {
    fail("head branch is required");
  }
  if (!Array.isArray(payload?.workflow_runs)) {
    fail("workflow_runs must be an array");
  }
  const runs = payload.workflow_runs
    .filter(
      (run) =>
        run?.path === CI_WORKFLOW &&
        run?.event === "pull_request" &&
        run?.head_sha === headSha &&
        run?.head_branch === headBranch &&
        run?.repository?.full_name === repository &&
        run?.head_repository?.full_name === repository,
    )
    .sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
  if (runs.length === 0) {
    return { action: "activate", headBranch, headSha };
  }

  const run = runs.at(-1);
  const runId = integer(run.id, "run id");
  const runAttempt = integer(run.run_attempt, "run attempt");
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  if (run.html_url !== runUrl) fail("run URL does not match exact identity");

  const context = {
    action: "",
    conclusion: run.conclusion ?? "",
    headBranch,
    headSha,
    runAttempt,
    runId,
    runUrl,
  };
  if (run.status !== "completed") {
    return { ...context, action: "wait" };
  }
  if (run.conclusion === "success") {
    return { ...context, action: "success" };
  }
  if (run.conclusion === "action_required") {
    return { ...context, action: "activate" };
  }
  if (RETRYABLE.has(run.conclusion) && runAttempt < 3) {
    return { ...context, action: "retry" };
  }
  if (
    RETRYABLE.has(run.conclusion) ||
    ["neutral", "skipped", "stale"].includes(run.conclusion)
  ) {
    return { ...context, action: "terminal" };
  }
  fail(`unsupported completed conclusion: ${run.conclusion ?? "missing"}`);
}

export function trainCiIssue(context, repository) {
  if (context.action !== "terminal") fail("issue requires terminal CI");
  const identity = `${repository}:${context.headSha}`;
  const marker = `<!-- kin-editor-release-pr-failure:${identity} -->`;
  return {
    marker,
    title: "[release failure] Kin Editor release PR exhausted automatic CI recovery",
    body: `${marker}
## Terminal automatic release-PR failure

The protected Kin Editor release PR exhausted its two bounded automatic CI
reruns. Auto-merge remains blocked by required checks.

- Branch: \`${context.headBranch}\`
- Head commit: \`${context.headSha}\`
- Failed run: [${context.runId}](${context.runUrl})
- Run attempt: \`${context.runAttempt}\`
- Conclusion: \`${context.conclusion}\`
- Automatic reruns exhausted: \`2\`
`,
    label: "release:terminal-failure",
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
    fail("stdin must contain workflow-runs JSON");
  }
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  const repository = args.get("repository");
  const headSha = args.get("head-sha");
  const headBranch = args.get("head-branch");
  const context = classifyTrainCi(await readStdin(), {
    repository,
    headSha,
    headBranch,
  });
  if (command === "classify") {
    process.stdout.write(`${JSON.stringify(context)}\n`);
    return;
  }
  if (command === "issue") {
    process.stdout.write(
      `${JSON.stringify(trainCiIssue(context, repository))}\n`,
    );
    return;
  }
  fail("command must be classify or issue");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
