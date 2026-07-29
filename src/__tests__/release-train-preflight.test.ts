// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release-train-preflight.mjs");
const REPOSITORY = "firelock-ai/kin-editor";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "automation/release-next";

function pull(overrides = {}) {
  return {
    number: 40,
    baseRefName: "main",
    headRefName: BRANCH,
    headRefOid: HEAD,
    isCrossRepository: false,
    headRepository: { nameWithOwner: REPOSITORY },
    headRepositoryOwner: { login: "firelock-ai" },
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

function run(attempt: number, conclusion: string, overrides = {}) {
  const id = 8000 + attempt;
  return {
    id,
    run_attempt: attempt,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion,
    head_branch: BRANCH,
    head_sha: HEAD,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function preflight(pullRequests: object[], workflowRuns: object[]) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--repository",
      REPOSITORY,
      "--head-branch",
      BRANCH,
      "--base-branch",
      "main",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: JSON.stringify({
        pullRequests,
        workflowRuns: { workflow_runs: workflowRuns },
      }),
    },
  );
}

describe("release-train mutation preflight", () => {
  it("proceeds when no protected release PR exists", () => {
    const result = preflight([], []);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "proceed",
      reason: "no-open-release-pr",
    });
  });

  it.each([
    [1, "failure", "retry"],
    [2, "timed_out", "retry"],
    [3, "failure", "terminal"],
    [1, "success", "success"],
  ])(
    "preserves exact head attempt %i conclusion %s as %s",
    (attempt, conclusion, action) => {
      const result = preflight([pull()], [run(attempt, conclusion)]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action,
        headSha: HEAD,
        prNumber: 40,
        runAttempt: attempt,
      });
    },
  );

  it("waits without mutation while exact-head CI is active", () => {
    const result = preflight(
      [pull()],
      [run(1, "", { status: "in_progress", conclusion: null })],
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe("wait");
  });

  it("permits activation only when exact-head CI is absent or action-required", () => {
    for (const workflowRuns of [[], [run(1, "action_required")]]) {
      const result = preflight([pull()], workflowRuns);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "proceed",
        reason: "exact-head-ci-needs-activation",
      });
    }
  });

  it("coalesces main only after the current exact head has succeeded", () => {
    const result = preflight(
      [pull({ mergeStateStatus: "BEHIND" })],
      [run(1, "success")],
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "proceed",
      reason: "successful-head-needs-main-coalescing",
    });
  });

  it("waits on unresolved successful-head merge state", () => {
    for (const mergeStateStatus of ["DIRTY", "DRAFT", "UNKNOWN"]) {
      const result = preflight(
        [pull({ mergeStateStatus })],
        [run(1, "success")],
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).action).toBe("wait");
    }
  });

  it("fails closed on duplicate, forked, or substituted release PRs", () => {
    for (const pullRequests of [
      [pull(), pull({ number: 41 })],
      [pull({ isCrossRepository: true })],
      [pull({ headRepository: { nameWithOwner: "attacker/fork" } })],
      [pull({ baseRefName: "other" })],
      [pull({ headRefName: "other" })],
    ]) {
      const result = preflight(pullRequests, [run(1, "failure")]);
      expect(result.status).toBe(1);
    }
  });
});
