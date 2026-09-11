// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  dedupeFindings,
  findingsFromGraphStatus,
  findingsFromPayload,
} from "../graph-findings";

function codes(findings: { code: string }[]): string[] {
  return findings.map((finding) => finding.code);
}

describe("findings from a tool response", () => {
  it("finds nothing in a clean answer", () => {
    // The negative control for every assertion below. Without it a reader
    // cannot tell a working check from one that returns rows for anything.
    const findings = findingsFromPayload({
      body: "fn x() {}",
      _kin: {
        envelope_version: 1,
        runtime: "repo-daemon",
        degraded: {},
        semantic_coverage: { indexed: 10, total: 10, pending: 0, complete: true },
        completeness: { status: "complete", bound: "exact", note: "" },
        verdict: { state: "conclusive" },
      },
    });
    expect(findings).toEqual([]);
  });

  it("finds nothing at all in a payload with no envelope", () => {
    expect(findingsFromPayload({ body: "fn x() {}" })).toEqual([]);
    expect(findingsFromPayload("not an object")).toEqual([]);
    expect(findingsFromPayload(undefined)).toEqual([]);
  });

  it("raises each degraded flag the daemon affirmatively set", () => {
    const findings = findingsFromPayload({
      _kin: {
        degraded: {
          enrichment_shortfall: true,
          sweep_suspended: true,
          daemon_unreachable: false,
          offline_fallback: null,
        },
      },
    });

    expect(codes(findings).sort()).toEqual([
      "degraded.enrichment_shortfall",
      "degraded.sweep_suspended",
    ]);
    expect(findings[0].severity).toBe("warning");
    expect(
      findings.find((f) => f.code === "degraded.enrichment_shortfall")?.message
    ).toContain("did not finish the job");
  });

  it("treats an observed-false flag as fine, not as a finding", () => {
    // kin writes each flag as Some(bool) and omits it when undetermined, so
    // `false` means observed and healthy. Raising it would put a warning on
    // every clean answer.
    expect(
      findingsFromPayload({ _kin: { degraded: { daemon_unreachable: false } } })
    ).toEqual([]);
  });

  it("raises an unknown degraded flag by name rather than swallowing it", () => {
    const findings = findingsFromPayload({
      _kin: { degraded: { some_future_condition: true } },
    });
    expect(codes(findings)).toEqual(["degraded.some_future_condition"]);
    expect(findings[0].message).toContain("some future condition");
  });

  it("ranks an error flag above a warning flag", () => {
    const findings = findingsFromPayload({
      _kin: {
        degraded: { enrichment_shortfall: true, daemon_unreachable: true },
      },
    });
    expect(findings[0].code).toBe("degraded.daemon_unreachable");
    expect(findings[0].severity).toBe("error");
  });

  it("quotes the daemon's own sentence for an inconclusive verdict", () => {
    const findings = findingsFromPayload({
      _kin: {
        degraded: {},
        verdict: {
          state: "inconclusive",
          limiting_factor:
            "graph_admission_unrecorded: this daemon reports no complete admission",
        },
      },
    });
    expect(codes(findings)).toEqual(["verdict.inconclusive"]);
    expect(findings[0].message).toContain("graph_admission_unrecorded");
    expect(findings[0].message).toContain("lower bound");
  });

  it("reports a partial answer as a floor and carries the daemon's note", () => {
    const findings = findingsFromPayload({
      _kin: {
        degraded: {},
        completeness: {
          status: "partial",
          bound: "at_least",
          note: "the vector index was empty for this language",
          limits: ["vector_sidecar"],
        },
      },
    });
    expect(codes(findings)).toEqual(["completeness.partial"]);
    expect(findings[0].message).toContain("at_least");
    expect(findings[0].message).toContain("vector index was empty");
  });

  it("reports pending embeddings, unadmitted paths and watcher loss", () => {
    const findings = findingsFromPayload({
      _kin: {
        degraded: {},
        semantic_coverage: {
          indexed: 700,
          total: 730,
          pending: 30,
          complete: false,
          limited_by: ["embed_worker"],
        },
        behind: {
          unadmitted_paths: 2,
          sample: ["src/new.rs", "src/other.rs"],
          note: "two paths have never reached graph truth",
        },
        watcher_loss: { generation: 9, disclosure: "queue overflow at 12:00Z" },
      },
    });

    expect(codes(findings).sort()).toEqual([
      "behind.unadmitted_paths",
      "semantic_coverage.incomplete",
      "watcher_loss",
    ]);
    expect(
      findings.find((f) => f.code === "semantic_coverage.incomplete")?.message
    ).toContain("700 of 730 embedded, 30 pending");
    expect(
      findings.find((f) => f.code === "behind.unadmitted_paths")?.message
    ).toContain("src/new.rs");
  });

  it("says nothing about freshness the daemon recorded, and speaks about the rest", () => {
    expect(
      findingsFromPayload({
        _kin: { degraded: {}, freshness: { state: "recorded", at: "now" } },
      })
    ).toEqual([]);

    const unrecorded = findingsFromPayload({
      _kin: { degraded: {}, freshness: { state: "no_admission_recorded" } },
    });
    expect(codes(unrecorded)).toEqual(["freshness.no_admission_recorded"]);
    expect(unrecorded[0].message).toContain("cannot be read as covering current code");

    const stale = findingsFromPayload({
      _kin: {
        degraded: {},
        freshness: {
          state: "stale",
          reason: "the embedding worker held the lock",
          settled_age_ms: 4200,
          live_attempts: 3,
        },
      },
    });
    expect(codes(stale)).toEqual(["freshness.stale"]);
    expect(stale[0].message).toContain("after 3 attempts");
    expect(stale[0].message).toContain("4200 ms earlier");
  });
});

describe("dangling references from edge_coverage", () => {
  it("names call sites the parser saw and the linker resolved into nothing", () => {
    const findings = findingsFromPayload({
      edge_coverage: {
        language: "python",
        reference_resolution: {
          parsed_call_sites: 41,
          resolved_call_edges: 12,
          parsed_import_statements: 8,
          resolved_import_statements: 8,
        },
      },
    });

    expect(codes(findings)).toEqual(["edge_coverage.dangling_calls"]);
    expect(findings[0].message).toContain("12 of 41 parsed call sites");
    expect(findings[0].message).toContain("for python");
    expect(findings[0].message).toContain("29 call sites");
  });

  it("says nothing when every parsed site resolved", () => {
    expect(
      findingsFromPayload({
        edge_coverage: {
          language: "rust",
          reference_resolution: {
            parsed_call_sites: 12,
            resolved_call_edges: 12,
            parsed_import_statements: 3,
            resolved_import_statements: 3,
          },
        },
      })
    ).toEqual([]);
  });

  it("treats an unmeasured parse side as unmeasured, not as zero", () => {
    // kin writes null when no file of the language carries a parse-side count.
    // Reading that as zero would turn "nothing counted the source" into "the
    // source had no calls", which is a claim about the code.
    expect(
      findingsFromPayload({
        edge_coverage: {
          language: "go",
          reference_resolution: {
            parsed_call_sites: null,
            resolved_call_edges: 0,
            parsed_import_statements: 5,
            resolved_import_statements: null,
          },
        },
      })
    ).toEqual([]);
  });

  it("separates an unproduced class from an absent one", () => {
    const findings = findingsFromPayload({
      edge_coverage: {
        language: "javascript",
        classes: {
          calls: { state: "unproduced" },
          imports: { state: "absent" },
          references: { state: "unknown" },
        },
      },
    });

    expect(codes(findings)).toEqual(["edge_coverage.unproduced.calls"]);
    expect(findings[0].message).toContain("gap in the build");
    expect(findings[0].message).toContain("not a statement that the code has no calls");
  });
});

describe("findings from kin_graph_status", () => {
  const report = {
    schema: "kin.graph-status.v1",
    view: "daemon_selected_graph",
    scope: "head",
    authority: "repo-daemon",
    sampling: "point_in_time_selected_graph",
    authority_epoch: 4,
    entity_count: 730,
    relation_count: 2100,
    embedding_source: "selected_graph",
    embeddings_indexed: 730,
    embeddings_pending: 0,
    embeddings_total: 730,
    completion_attested: false,
  };

  it("says outright that enrichment completion is unattested", () => {
    const findings = findingsFromGraphStatus(report);
    expect(codes(findings)).toEqual(["graph_status.completion_unattested"]);
    expect(findings[0].message).toContain("not a guarantee");
  });

  it("reports pending embeddings and vectors the graph no longer admits", () => {
    const findings = findingsFromGraphStatus({
      ...report,
      embeddings_indexed: 600,
      embeddings_pending: 130,
      embedding_index_keys: 640,
      embedding_keys_not_in_graph: 40,
    });

    expect(codes(findings).sort()).toEqual([
      "graph_status.completion_unattested",
      "graph_status.embeddings_pending",
      "graph_status.stale_vectors",
    ]);
    expect(
      findings.find((f) => f.code === "graph_status.stale_vectors")?.severity
    ).toBe("warning");
  });

  it("says when the counters replay an earlier instant", () => {
    const findings = findingsFromGraphStatus({
      ...report,
      sampling: "last_settled_selected_graph",
      stale: { reason: "embedding work held serialization" },
    });
    expect(codes(findings)).toContain("graph_status.sample_replayed");
    expect(
      findings.find((f) => f.code === "graph_status.sample_replayed")?.message
    ).toContain("embedding work held serialization");
  });

  it("reads nothing from something that is not a report", () => {
    expect(findingsFromGraphStatus(undefined)).toEqual([]);
    expect(findingsFromGraphStatus("{}")).toEqual([]);
  });
});

describe("merging findings", () => {
  it("keeps one row per code at its worst severity, worst first", () => {
    const merged = dedupeFindings(
      [{ code: "a", severity: "info", message: "first" }],
      [
        { code: "a", severity: "error", message: "worse" },
        { code: "b", severity: "warning", message: "other" },
      ]
    );

    expect(merged.map((f) => [f.code, f.severity])).toEqual([
      ["a", "error"],
      ["b", "warning"],
    ]);
    expect(merged[0].message).toBe("worse");
  });

  it("does not downgrade a finding it already has", () => {
    const merged = dedupeFindings(
      [{ code: "a", severity: "error", message: "worse" }],
      [{ code: "a", severity: "info", message: "milder" }]
    );
    expect(merged).toEqual([{ code: "a", severity: "error", message: "worse" }]);
  });
});
