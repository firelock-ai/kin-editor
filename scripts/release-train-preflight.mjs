#!/usr/bin/env node

// Classify an existing protected release PR before the controller is allowed
// to coalesce main or rewrite the release branch. Failed exact heads retain
// their GitHub run_attempt history until bounded recovery reaches a terminal
// result.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { classifyTrainCi } from "./release-train-ci-policy.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(message) {
  throw new Error(`release train preflight: ${message}`);
}

export function classifyExistingTrain(
  payload,
  {
    repository,
    headBranch = "automation/release-next",
    baseBranch = "main",
  },
) {
  if (!REPOSITORY.test(repository ?? "")) fail("repository must be owner/name");
  if (!Array.isArray(payload?.pullRequests)) {
    fail("pullRequests must be an array");
  }
  if (payload.pullRequests.length === 0) {
    return { action: "proceed", reason: "no-open-release-pr" };
  }
  if (payload.pullRequests.length !== 1) {
    fail("exactly zero or one open release PR is allowed");
  }

  const pull = payload.pullRequests[0];
  if (!Number.isSafeInteger(pull?.number) || pull.number < 1) {
    fail("pull request number is invalid");
  }
  if (pull.baseRefName !== baseBranch) fail("release PR base is not trusted");
  if (pull.headRefName !== headBranch) fail("release PR branch is not trusted");
  if (pull.isCrossRepository !== false) fail("release PR must not be a fork");
  if (pull.headRepository?.nameWithOwner !== repository) {
    fail("release PR repository is not trusted");
  }
  if (pull.headRepositoryOwner?.login !== repository.split("/")[0]) {
    fail("release PR owner is not trusted");
  }
  if (!SHA.test(pull.headRefOid ?? "")) fail("release PR head is not exact");

  const decision = classifyTrainCi(payload.workflowRuns, {
    repository,
    headSha: pull.headRefOid,
    headBranch,
  });
  const context = {
    ...decision,
    mergeStateStatus: pull.mergeStateStatus ?? "UNKNOWN",
    prNumber: pull.number,
  };

  if (decision.action === "activate") {
    return {
      ...context,
      action: "proceed",
      reason: "exact-head-ci-needs-activation",
    };
  }
  if (
    decision.action === "success" &&
    pull.mergeStateStatus === "BEHIND"
  ) {
    return {
      ...context,
      action: "proceed",
      reason: "successful-head-needs-main-coalescing",
    };
  }
  if (
    decision.action === "success" &&
    ["DIRTY", "DRAFT", "UNKNOWN"].includes(pull.mergeStateStatus)
  ) {
    return {
      ...context,
      action: "wait",
      reason: `successful-head-merge-state-${pull.mergeStateStatus.toLowerCase()}`,
    };
  }
  return context;
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
    fail("stdin must contain preflight JSON");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = args.get("repository");
  const headBranch = args.get("head-branch") ?? "automation/release-next";
  const baseBranch = args.get("base-branch") ?? "main";
  const decision = classifyExistingTrain(await readStdin(), {
    repository,
    headBranch,
    baseBranch,
  });
  process.stdout.write(`${JSON.stringify(decision)}\n`);
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
