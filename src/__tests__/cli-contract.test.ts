// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Contract tests for the CLI fallback readers.
//
// Each fixture under `fixtures/cli/` is the verbatim stdout of a real
// `kin 0.6.0` invocation, stamped with the command that produced it and the
// `kin --version` of the binary that answered. These tests run those bytes
// through the same readers the extension uses, so a CLI whose JSON moves breaks
// a test here rather than silently emptying a pane.
//
// Every reader also gets its drift arms: a 0.5-era shape, a key deleted from
// the real payload, and a wrong top-level type. Each arm asserts the exact
// reason and the exact missing keys, so two different causes reported through
// one field cannot pass for each other.

import { readFileSync } from "fs";
import { join } from "path";
import {
  ContractDrift,
  ContractResult,
  KNOWN_STATUS_SCHEMAS,
  describeDrift,
  readEntities,
  readOverview,
  readReview,
  readStatus,
} from "../cli-contract";

interface Fixture {
  capture: {
    command: string;
    kin_version: string;
    captured_at: string;
    exit_code: number;
    subject: string;
  };
  payload: unknown;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", "cli", `${name}.json`), "utf8")
  ) as Fixture;
}

/** Deep clone so one arm's mutation cannot leak into the next. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectDrift<T>(result: ContractResult<T>): ContractDrift {
  if (result.ok) {
    throw new Error(
      `expected contract drift, got a readable value: ${JSON.stringify(result.value)}`
    );
  }
  return result;
}

function expectOk<T>(result: ContractResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected a readable value, got drift: ${describeDrift(result)}`);
  }
  return result.value;
}

const FIXTURES = ["status", "overview", "search", "trace", "review"] as const;

describe("CLI fixtures", () => {
  // The fixtures are the evidence these tests rest on. If one is regenerated
  // against a different binary, or hand-edited, the provenance stamp is the
  // only thing that says so.
  it.each(FIXTURES)("%s carries the command and binary that produced it", (name) => {
    const fixture = loadFixture(name);
    expect(fixture.capture.command).toMatch(/^kin \S+.* --json$/);
    expect(fixture.capture.kin_version).toMatch(/^kin \d+\.\d+\.\d+ \(/);
    expect(fixture.capture.exit_code).toBe(0);
    expect(fixture.capture.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(fixture.payload).toBeDefined();
  });

  it("all five fixtures came from one binary", () => {
    const versions = new Set(FIXTURES.map((n) => loadFixture(n).capture.kin_version));
    expect([...versions]).toHaveLength(1);
  });
});

describe("readStatus", () => {
  it("reads the real kin 0.6.0 status payload", () => {
    const status = expectOk(readStatus(loadFixture("status").payload));
    // Measured: semantic_enrichment.entity_count is 14 and completion_attested
    // is false on this store, so the state says so rather than "healthy".
    expect(status).toEqual({
      initialized: true,
      entityCount: 14,
      graphState: "present, completion not attested",
      reachable: true,
    });
  });

  it("emits no schema note for a known contract", () => {
    const result = readStatus(loadFixture("status").payload);
    expect(result.ok).toBe(true);
    expect(result.ok && result.note).toBeUndefined();
  });

  it("pins the schema it was measured against", () => {
    const fixture = loadFixture("status");
    expect(KNOWN_STATUS_SCHEMAS).toContain(
      (fixture.payload as { schema: string }).schema
    );
  });

  it("reports drift on a 0.5-era top-level shape", () => {
    // The shape the extension used to expect: a numeric output version and the
    // three fields read straight off the top level. Nothing in kin 0.6.0 emits
    // it, and the old guard could not see the difference.
    const legacy = {
      version: 1,
      initialized: true,
      entityCount: 5,
      graphState: "healthy",
    };
    const drift = expectDrift(readStatus(legacy));
    expect(drift.reason).toBe("missing-top-level-keys");
    expect(drift.missing).toEqual(["schema", "repository", "semantic_enrichment"]);
    expect(describeDrift(drift)).toContain("kin status --json");
    expect(describeDrift(drift)).toContain("Update the Kin VS Code extension");
  });

  it("reports drift when semantic_enrichment is deleted from the real payload", () => {
    const payload = clone(loadFixture("status").payload) as Record<string, unknown>;
    delete payload.semantic_enrichment;
    const drift = expectDrift(readStatus(payload));
    expect(drift.reason).toBe("missing-top-level-keys");
    expect(drift.missing).toEqual(["semantic_enrichment"]);
    expect(drift.schema).toBe("kin.status.v3");
  });

  it("reports nested drift when entity_count is deleted, distinct from a top-level miss", () => {
    const payload = clone(loadFixture("status").payload) as {
      semantic_enrichment: Record<string, unknown>;
    };
    delete payload.semantic_enrichment.entity_count;
    const drift = expectDrift(readStatus(payload));
    // The reason separates this from the arm above. Both would otherwise report
    // through the same field and pass for each other.
    expect(drift.reason).toBe("missing-nested-keys");
    expect(drift.missing).toEqual(["semantic_enrichment.entity_count"]);
  });

  it("reports the wrong top-level type distinctly", () => {
    const drift = expectDrift(readStatus([1, 2, 3]));
    expect(drift.reason).toBe("wrong-top-level-type");
    expect(drift.detail).toContain("a JSON array of 3 item(s)");
  });

  it("reads an unknown schema but says so", () => {
    const payload = clone(loadFixture("status").payload) as Record<string, unknown>;
    payload.schema = "kin.status.v9";
    const result = readStatus(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    // Structure intact, so the answer is still read. The user is told once.
    expect(result.value.entityCount).toBe(14);
    expect(result.note?.reason).toBe("unknown-schema");
    expect(result.note?.schema).toBe("kin.status.v9");
  });

  it("says presence when enrichment is absent rather than inventing health", () => {
    const payload = clone(loadFixture("status").payload) as {
      semantic_enrichment: Record<string, unknown>;
    };
    payload.semantic_enrichment.presence = "absent";
    expect(expectOk(readStatus(payload)).graphState).toBe("absent");
  });

  it("says completion attested when the CLI attests it", () => {
    const payload = clone(loadFixture("status").payload) as {
      semantic_enrichment: Record<string, unknown>;
    };
    payload.semantic_enrichment.completion_attested = true;
    expect(expectOk(readStatus(payload)).graphState).toBe("present, completion attested");
  });
});

describe("readOverview", () => {
  it("reads the real kin 0.6.0 overview payload", () => {
    const overview = expectOk(readOverview(loadFixture("overview").payload));
    expect(overview.entities).toBe(14);
    expect(overview.edges).toBe(50);
    expect(overview.files).toBe(3);
    expect(overview.kinds).toEqual({
      Class: 1,
      Constant: 1,
      Function: 4,
      Method: 3,
      Module: 5,
    });
    expect(overview.availability).toBe("indexed");
    expect(overview.indexed).toBe(true);
  });

  it("reports drift when kinds is deleted from the real payload", () => {
    const payload = clone(loadFixture("overview").payload) as Record<string, unknown>;
    delete payload.kinds;
    const drift = expectDrift(readOverview(payload));
    expect(drift.reason).toBe("missing-top-level-keys");
    expect(drift.missing).toEqual(["kinds"]);
  });

  it("reports drift on an array", () => {
    const drift = expectDrift(readOverview([]));
    expect(drift.reason).toBe("wrong-top-level-type");
  });

  it("calls a reachable zero-entity graph empty, not drift", () => {
    const overview = expectOk(
      readOverview({ entities: 0, edges: 0, files: 0, kinds: {} })
    );
    expect(overview.availability).toBe("empty");
  });
});

describe("readEntities", () => {
  it("reads the real kin 0.6.0 search payload", () => {
    const entities = expectOk(readEntities("search", loadFixture("search").payload));
    expect(entities).toHaveLength(12);
    expect(entities[0]).toEqual({
      kind: "Function",
      name: "build_router",
      file: "router.py",
      line: 20,
      signature: "def build_router(config)",
    });
    // Every element normalises to the four fields the UI dereferences, so no
    // pane can render "undefined:undefined" off a well-formed answer.
    for (const entity of entities) {
      expect(typeof entity.name).toBe("string");
      expect(typeof entity.file).toBe("string");
      expect(Number.isFinite(entity.line)).toBe(true);
      expect(entity.name).not.toBe("");
    }
  });

  it("reads the real kin 0.6.0 trace payload", () => {
    const entities = expectOk(readEntities("trace", loadFixture("trace").payload));
    expect(entities).toEqual([
      {
        kind: "Function",
        name: "build_router",
        file: "router.py",
        line: 20,
        signature: "def build_router(config)",
      },
    ]);
  });

  it("treats an empty array as an empty answer, not drift", () => {
    // A query that found nothing publishes no element keys. Reporting drift on
    // it would fire the warning on every miss.
    const result = readEntities("search", []);
    expect(result.ok).toBe(true);
    expect(expectOk(result)).toEqual([]);
  });

  it("reports drift when the top level is an object", () => {
    // The 0.5-era shape: an object carrying entities/files/summary.
    const drift = expectDrift(
      readEntities("search", { entities: [], files: [], summary: "none" })
    );
    expect(drift.reason).toBe("wrong-top-level-type");
    expect(drift.detail).toContain("not a JSON array");
    expect(drift.missing).toEqual(["kind", "name", "file", "line"]);
  });

  it("reports drift when an element loses the file key", () => {
    const payload = clone(loadFixture("search").payload) as Record<string, unknown>[];
    delete payload[0].file;
    const drift = expectDrift(readEntities("search", payload));
    expect(drift.reason).toBe("missing-element-keys");
    expect(drift.missing).toEqual(["file"]);
  });

  it("accepts a documented alias for a renamed key", () => {
    const payload = clone(loadFixture("search").payload) as Record<string, unknown>[];
    payload[0].file_path = payload[0].file;
    delete payload[0].file;
    const entities = expectOk(readEntities("search", payload));
    expect(entities[0].file).toBe("router.py");
  });

  it("names the command it was reading", () => {
    expect(describeDrift(expectDrift(readEntities("trace", {})))).toContain(
      "kin trace --json"
    );
  });
});

describe("readReview", () => {
  it("reads the real kin 0.6.0 review payload", () => {
    const review = expectOk(readReview(loadFixture("review").payload, "app.py"));
    expect(review.file).toBe("app.py");
    expect(review.summary).toBe("Overall risk: Low; 3 finding(s)");
    expect(review.findings).toHaveLength(3);
    expect(review.findings[0]).toEqual({
      entity: "app.py",
      kind: "Added",
      file: "app.py",
      line: 0,
      severity: "info",
      message: "New Module `app` — module app.py",
    });
  });

  it("reports drift when findings is deleted from the real payload", () => {
    const payload = clone(loadFixture("review").payload) as Record<string, unknown>;
    delete payload.findings;
    const drift = expectDrift(readReview(payload, "app.py"));
    expect(drift.reason).toBe("missing-top-level-keys");
    expect(drift.missing).toEqual(["findings"]);
  });

  it("reports drift when a finding loses its message", () => {
    const payload = clone(loadFixture("review").payload) as {
      findings: Record<string, unknown>[];
    };
    delete payload.findings[0].message;
    const drift = expectDrift(readReview(payload, "app.py"));
    expect(drift.reason).toBe("missing-element-keys");
    expect(drift.missing).toEqual(["message"]);
  });

  it("separates a non-array findings value from a missing one", () => {
    const payload = clone(loadFixture("review").payload) as Record<string, unknown>;
    payload.findings = "three";
    const drift = expectDrift(readReview(payload, "app.py"));
    expect(drift.missing).toEqual(["findings"]);
    // Same missing key as the deletion arm above, so the detail is what
    // separates them. Assert it, or the two cases are one test.
    expect(drift.detail).toContain("carried findings as a JSON string");
  });

  it("treats an empty findings array as a clean review", () => {
    const review = expectOk(
      readReview({ file: "a.py", findings: [], summary: "no findings" }, "a.py")
    );
    expect(review.findings).toEqual([]);
    expect(review.summary).toBe("no findings");
  });

  it("falls back to the reviewed path when a finding omits its file", () => {
    const payload = clone(loadFixture("review").payload) as {
      findings: Record<string, unknown>[];
    };
    delete payload.findings[0].file;
    const review = expectOk(readReview(payload, "app.py"));
    expect(review.findings[0].file).toBe("app.py");
  });
});
