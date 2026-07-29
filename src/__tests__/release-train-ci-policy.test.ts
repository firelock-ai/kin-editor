// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release-train-ci-policy.mjs");
const REPOSITORY = "firelock-ai/kin-editor";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "automation/release-next";
const TRAIN_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "release-train.yml"),
  "utf8",
);
const TAG_WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "release-tag.yml"),
  "utf8",
);

function run(attempt: number, conclusion: string, overrides = {}) {
  const id = 7000 + attempt;
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
    created_at: `2026-07-28T00:00:0${attempt}Z`,
    ...overrides,
  };
}

function policy(command: "classify" | "issue", workflowRuns: object[]) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      command,
      "--repository",
      REPOSITORY,
      "--head-sha",
      HEAD,
      "--head-branch",
      BRANCH,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: JSON.stringify({ workflow_runs: workflowRuns }),
    },
  );
}

describe("release-train CI recovery policy", () => {
  it("is wired to bounded exact-head retry and terminal escalation", () => {
    expect(TRAIN_WORKFLOW).toContain("actions: write");
    expect(TRAIN_WORKFLOW).toContain(
      "Recover existing exact-head CI before release-branch mutation",
    );
    expect(TRAIN_WORKFLOW).toContain(
      "node scripts/release-train-preflight.mjs",
    );
    expect(TRAIN_WORKFLOW).toContain(
      "node scripts/release-train-ci-policy.mjs classify",
    );
    expect(TRAIN_WORKFLOW).toContain("steps.pr.outputs.ci_action == 'retry'");
    expect(TRAIN_WORKFLOW).toContain("rerun-failed-jobs");
    expect(TRAIN_WORKFLOW).toContain("steps.pr.outputs.ci_action == 'terminal'");
    expect(TRAIN_WORKFLOW).toContain(
      "node scripts/release-train-ci-policy.mjs issue",
    );
    expect(TRAIN_WORKFLOW).toContain(
      "multiple terminal release-PR issues carry",
    );
    expect(
      TRAIN_WORKFLOW.indexOf(
        "Recover existing exact-head CI before release-branch mutation",
      ),
    ).toBeLessThan(
      TRAIN_WORKFLOW.indexOf("Create or coalesce the release branch"),
    );
    expect(TRAIN_WORKFLOW).toContain(
      "if: steps.recovery.outputs.handled != 'true'",
    );
  });

  it("enforces squash-only PR-body intent before reconciliation", () => {
    expect(TRAIN_WORKFLOW).toContain(".allow_merge_commit == false");
    expect(TRAIN_WORKFLOW).toContain(".allow_rebase_merge == false");
    expect(TRAIN_WORKFLOW).toContain(
      '.squash_merge_commit_title == "PR_TITLE"',
    );
    expect(TRAIN_WORKFLOW).toContain(
      '.squash_merge_commit_message == "PR_BODY"',
    );
  });

  it("tags only the exact version-introducing checked commit", () => {
    expect(TAG_WORKFLOW).toContain(
      "node scripts/resolve-version-commit.mjs",
    );
    expect(TAG_WORKFLOW).toContain(
      "commits/${release_sha}/check-runs?per_page=100",
    );
    expect(TAG_WORKFLOW).toContain('--arg object "$release_sha"');
    expect(TAG_WORKFLOW).toContain(
      'test "$(git rev-parse "${tag}^{commit}")" = "$release_sha"',
    );
    expect(TAG_WORKFLOW).not.toContain('--arg object "$main_sha"');
  });

  it.each([
    [1, "failure", "retry"],
    [2, "timed_out", "retry"],
    [3, "failure", "terminal"],
    [4, "cancelled", "terminal"],
    [1, "action_required", "activate"],
    [1, "success", "success"],
  ])(
    "routes attempt %i conclusion %s to %s",
    (attempt, conclusion, action) => {
      const result = policy("classify", [run(attempt, conclusion)]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).action).toBe(action);
    },
  );

  it("waits for an exact active run and activates when no exact run exists", () => {
    const active = policy("classify", [
      run(1, "", { status: "in_progress", conclusion: null }),
    ]);
    expect(JSON.parse(active.stdout).action).toBe("wait");

    const unrelated = policy("classify", [
      run(1, "success", { head_sha: "f".repeat(40) }),
    ]);
    expect(JSON.parse(unrelated.stdout).action).toBe("activate");
  });

  it("uses the newest exact run id when duplicate deliveries are visible", () => {
    const newer = run(1, "success", {
      id: 9000,
      html_url: `https://github.com/${REPOSITORY}/actions/runs/9000`,
    });
    const result = policy("classify", [newer, run(2, "failure")]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "success",
      runId: 9000,
    });
  });

  it("refuses fork, workflow, and URL substitutions", () => {
    for (const overrides of [
      { head_repository: { full_name: "attacker/fork" } },
      { path: ".github/workflows/release.yml" },
      { html_url: "https://example.invalid/run" },
    ]) {
      const result = policy("classify", [run(3, "failure", overrides)]);
      if ("html_url" in overrides) {
        expect(result.status).toBe(1);
      } else {
        expect(JSON.parse(result.stdout).action).toBe("activate");
      }
    }
  });

  it("builds one deterministic terminal issue for the exact head", () => {
    const first = policy("issue", [run(3, "failure")]);
    const repeated = policy("issue", [run(3, "failure")]);
    expect(first.status).toBe(0);
    expect(repeated.stdout).toBe(first.stdout);
    const issue = JSON.parse(first.stdout);
    expect(issue.marker).toContain(`${REPOSITORY}:${HEAD}`);
    expect(issue.body).toContain("Automatic reruns exhausted: `2`");
  });
});
