// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "release-recovery-policy.mjs");
const WORKFLOW = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "release-recovery.yml",
);
const REPOSITORY = "firelock-ai/kin-editor";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function releaseRun(attempt: number, overrides = {}) {
  const runId = 4000 + attempt;
  return {
    id: runId,
    run_attempt: attempt,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    path: ".github/workflows/release.yml",
    event: "push",
    status: "completed",
    conclusion: "failure",
    head_branch: "v0.1.2",
    head_sha: SHA,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function policy(
  command: "validate" | "issue",
  run: object,
  expected?: "retry" | "escalate",
) {
  const args = [
    SCRIPT,
    command,
    "--repository",
    REPOSITORY,
  ];
  if (expected) args.push("--expect", expected);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: JSON.stringify(run),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("release recovery policy", () => {
  it.each([
    [1, "retry"],
    [2, "retry"],
    [3, "escalate"],
    [4, "escalate"],
    [99, "escalate"],
  ] as const)("routes attempt %i to %s only", (attempt, expected) => {
    const admitted = policy("validate", releaseRun(attempt), expected);
    expect(admitted.status).toBe(0);
    expect(JSON.parse(admitted.stdout)).toMatchObject({
      runAttempt: attempt,
      action: expected,
    });

    const opposite = expected === "retry" ? "escalate" : "retry";
    const refused = policy("validate", releaseRun(attempt), opposite);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`requires ${expected}, not ${opposite}`);
  });

  it("fails closed for workflow_dispatch and non-release authority", () => {
    for (const overrides of [
      { event: "workflow_dispatch" },
      { path: ".github/workflows/other.yml" },
      { head_branch: "v0.1.2-rc.1" },
      { head_sha: "not-a-sha" },
      { repository: { full_name: "attacker/fork" } },
    ]) {
      const result = policy("validate", releaseRun(3, overrides), "escalate");
      expect(result.status).toBe(1);
    }
  });

  it("keeps one deterministic issue identity per immutable tag", () => {
    const first = policy("issue", releaseRun(3));
    const repeated = policy("issue", releaseRun(3));
    expect(first.status).toBe(0);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toBe(first.stdout);

    const issue = JSON.parse(first.stdout);
    expect(issue).toMatchObject({
      identity: `${REPOSITORY}:v0.1.2`,
      label: "release:terminal-failure",
    });
    expect(issue.marker).toContain(`${REPOSITORY}:v0.1.2`);
    expect(issue.body).toContain("`v0.1.2`");
    expect(issue.body).toContain(`\`${SHA}\``);
    expect(issue.body).toContain(
      "https://github.com/firelock-ai/kin-editor/actions/runs/4003",
    );

    const laterRun = policy(
      "issue",
      releaseRun(4, {
        id: 9004,
        html_url:
          "https://github.com/firelock-ai/kin-editor/actions/runs/9004",
      }),
    );
    expect(laterRun.status).toBe(0);
    const updated = JSON.parse(laterRun.stdout);
    expect(updated.marker).toBe(issue.marker);
    expect(updated.title).toBe(issue.title);
    expect(updated.body).toContain(
      "https://github.com/firelock-ai/kin-editor/actions/runs/9004",
    );
    expect(updated.body).toContain("Run attempt: `4`");
  });
});

describe("release recovery workflow", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("keeps retry and escalation permissions disjoint and narrow", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toMatch(
      /retry:[\s\S]*?run_attempt < 3[\s\S]*?permissions:\n {6}actions: write\n {6}contents: read/,
    );
    expect(workflow).toMatch(
      /escalate:[\s\S]*?run_attempt >= 3[\s\S]*?permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write/,
    );
    const retry = workflow.slice(
      workflow.indexOf("  retry:"),
      workflow.indexOf("  escalate:"),
    );
    expect(retry).not.toContain("issues: write");
    expect(workflow.slice(workflow.indexOf("  escalate:"))).not.toContain(
      "actions: write",
    );
  });

  it("reconciles one marker-keyed issue and fails on ambiguity", () => {
    expect(workflow).toContain("release-recovery-policy.mjs issue");
    expect(workflow).toContain("contains($marker)");
    expect(workflow).toContain('.user.login == "github-actions[bot]"');
    expect(workflow).toContain('count="$(jq -r length');
    expect(workflow).toContain('"repos/${REPO}/issues/${number}"');
    expect(workflow).toContain("multiple terminal issues carry exact marker");
    expect(workflow).toContain('state:"open"');
  });

  it("has no manual or dispatch release-recovery path", () => {
    expect(workflow).toContain('workflows: ["Release"]');
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
  });
});
