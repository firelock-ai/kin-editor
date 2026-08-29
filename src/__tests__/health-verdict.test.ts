// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// FIR-2925, editor half: the readiness banner reads the health report's
// `verdict`, not its `healthy` boolean.
//
// kin #1236 added `verdict` with the values ready / needs_attention / failing,
// computed by one join over the component states, because `healthy: false`
// meant two things no consumer could separate: an install still warming up on
// a small host, and an install that is broken. This extension read `healthy`,
// declared a five-value status union with no `pending` and no `degraded`, and
// normalized both of those to `missing`, so a fresh install's model download
// rendered as a red Missing row inside a warn banner.
//
// One test per behavior below, so a mutation names the behavior it broke
// rather than turning a block of assertions red at once.

import {
  HealthCheck,
  HealthReport,
  HealthStatusValue,
  composeReadiness,
  parseHealthReport,
} from "../setup-health";
import { toolbarCommands } from "../setup-panel";

jest.mock(
  "vscode",
  () => ({
    workspace: { getConfiguration: () => ({ get: () => "" }) },
    Uri: { file: (p: string) => ({ fsPath: p }) },
  }),
  { virtual: true }
);

function check(
  id: string,
  status: HealthStatusValue,
  extra: Partial<HealthCheck> = {}
): Record<string, unknown> {
  return {
    id,
    label: extra.label ?? id,
    status,
    detail: extra.detail ?? "",
    platform_note: null,
    fixable: extra.fixable ?? false,
    manual_fix: extra.manual_fix ?? null,
  };
}

/** Build the wire payload `kin setup status --json` writes, and parse it. */
function report(
  checks: Record<string, unknown>[],
  aggregate: Record<string, unknown>
): HealthReport {
  return parseHealthReport(
    JSON.stringify({ platform: "macos", checks, ...aggregate })
  );
}

const READY = { healthy: true, verdict: "ready" };
const WARMING = { healthy: false, verdict: "needs_attention" };
const BROKEN = { healthy: false, verdict: "failing" };

describe("the fixtures reach the code they are asserting about", () => {
  // Without this, a payload the parser silently rejected would make every
  // assertion below vacuous, and a green run would mean nothing.
  it("parses the wire shape into the fields the banner reads", () => {
    const parsed = report([check("a", "healthy")], READY);
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.verdict).toBe("ready");
    expect(parsed.verdictSource).toEqual({ kind: "report" });
  });
});

describe("the banner reads the published verdict", () => {
  it("renders ready as ready", () => {
    const line = composeReadiness(report([check("a", "healthy")], READY));
    expect(line.verdict).toBe("ready");
    expect(line.tone).toBe("ok");
    expect(line.headline).toContain("Kin is ready in this workspace");
  });

  it("renders needs_attention distinctly from ready and from failing", () => {
    const line = composeReadiness(
      report(
        [check("a", "healthy"), check("embedding_model", "pending", { label: "Embedding model" })],
        WARMING
      )
    );
    expect(line.verdict).toBe("needs_attention");
    // Distinct from ready: a different tone, and it does not claim readiness.
    expect(line.tone).toBe("warn");
    expect(line.headline).not.toContain("Kin is ready");
    // Distinct from failing: it says outright that the install is not broken.
    expect(line.tone).not.toBe("bad");
    expect(line.headline).toContain("Nothing about the install is wrong");
    // And it names the row it is about, which the old count-only banner did not.
    expect(line.named).toEqual(["Embedding model"]);
  });

  it("renders failing as failing and names the blocking row", () => {
    const line = composeReadiness(
      report(
        [check("a", "healthy"), check("shell_hook", "missing", { label: "Shell hook" })],
        BROKEN
      )
    );
    expect(line.verdict).toBe("failing");
    expect(line.tone).toBe("bad");
    expect(line.headline).toContain("Shell hook");
    expect(line.headline).toContain("Something about this install is wrong");
  });
});

describe("pending and degraded are not faults", () => {
  it("keeps pending and degraded as themselves rather than as missing", () => {
    const parsed = report(
      [check("embedding_model", "pending"), check("memory_floor", "degraded")],
      WARMING
    );
    expect(parsed.checks.map((c) => c.status)).toEqual(["pending", "degraded"]);
  });

  it("tells a warming install to wait rather than to read a fix that is not there", () => {
    const line = composeReadiness(
      report([check("embedding_model", "pending", { label: "Embedding model" })], WARMING)
    );
    expect(line.advice).toBe("This is work still in flight. Re-check in a moment.");
  });
});

describe("a CLI that publishes no verdict", () => {
  const noVerdictButPending = [
    check("a", "healthy"),
    check("embedding_model", "pending", { label: "Embedding model" }),
  ];

  it("derives the verdict from the rows rather than trusting healthy alone", () => {
    // This is the FIR-2919 defect seen from the consumer side: the pre-rework
    // roll-up said `healthy: true` over rows that needed attention. Keying the
    // banner on that boolean reproduces it one layer up.
    const parsed = report(noVerdictButPending, { healthy: true });
    expect(parsed.healthy).toBe(true);
    expect(parsed.verdict).toBe("needs_attention");
  });

  it("says the state was read from the rows, and which update reports it directly", () => {
    const line = composeReadiness(report(noVerdictButPending, { healthy: true }));
    expect(line.sourceNote).toBe(
      "This kin CLI does not publish an overall verdict, so the state above was read from the rows below. Update kin to have it reported directly."
    );
  });

  it("maps a pre-verdict healthy:false onto failing, which is the same fact", () => {
    const parsed = report(
      [check("shell_hook", "missing")],
      { healthy: false }
    );
    expect(parsed.verdict).toBe("failing");
    expect(parsed.verdictSource).toEqual({ kind: "absent" });
  });
});

describe("a CLI that publishes a verdict this extension does not know", () => {
  // Kept apart from the absent case on purpose. Told they are the same, a user
  // reads "this kin CLI does not publish an overall verdict" about a CLI that
  // published one, and updates the wrong side.
  const payload = [check("a", "healthy"), check("b", "stale", { label: "B" })];

  it("does not accept the unknown word as a verdict", () => {
    const parsed = report(payload, { healthy: true, verdict: "mostly_fine" });
    expect(parsed.verdict).toBe("needs_attention");
    expect(parsed.verdictSource).toEqual({
      kind: "unrecognized",
      published: "mostly_fine",
    });
  });

  it("names the word it did not recognize and points at the extension", () => {
    const line = composeReadiness(
      report(payload, { healthy: true, verdict: "mostly_fine" })
    );
    expect(line.sourceNote).toContain('"mostly_fine"');
    expect(line.sourceNote).toContain("Update the Kin extension.");
    expect(line.sourceNote).not.toContain("does not publish an overall verdict");
  });
});

describe("a status word this extension does not know", () => {
  it("is not rendered as an accusation", () => {
    const parsed = report([check("x", "bananas" as HealthStatusValue)], WARMING);
    expect(parsed.checks[0].status).toBe("unknown");
    expect(parsed.checks[0].rawStatus).toBe("bananas");
  });

  it("keeps the report out of ready without making it failing", () => {
    const parsed = report(
      [check("a", "healthy"), check("x", "bananas" as HealthStatusValue)],
      { healthy: true }
    );
    expect(parsed.verdict).toBe("needs_attention");
  });
});

describe("the semantic search action", () => {
  it("is still offered while an install is warming up", () => {
    // The old gate was `report.healthy`, which on a pre-rework CLI was true for
    // everything that was not failing. Narrowing it to `ready` would have
    // hidden a working search from every warming install.
    const commands = toolbarCommands(
      report([check("embedding_model", "pending")], WARMING)
    );
    expect(commands).toContain("search");
  });

  it("is withheld when the install is failing", () => {
    const commands = toolbarCommands(
      report([check("shell_hook", "missing")], BROKEN)
    );
    expect(commands).not.toContain("search");
  });
});

describe("a roll-up that disagrees with its own rows", () => {
  it("reports the disagreement rather than choosing a side", () => {
    const line = composeReadiness(
      report([check("embedding_model", "pending")], { healthy: true, verdict: "ready" })
    );
    expect(line.verdict).toBe("ready");
    expect(line.disagreementNote).toContain("reported ready while 1 row below");
  });

  it("stays silent when the verdict and the rows agree", () => {
    const line = composeReadiness(report([check("a", "healthy")], READY));
    expect(line.disagreementNote).toBeNull();
  });
});
