// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { findingsFromPayload } from "../graph-findings";

function render(envelope: Record<string, unknown>): string {
  return findingsFromPayload({ _kin: envelope }).map((finding) => finding.message).join("\n");
}

describe("versioned MCP diagnostic rendering", () => {
  it.each([undefined, 1])("preserves legacy producer sentences for version %s", (envelope_version) => {
    const explanation = "graph_admission_unrecorded: no complete admission was recorded; this is the daemon's detail.";
    expect(render({ envelope_version, verdict: { state: "inconclusive", limiting_factor: explanation } }))
      .toContain(explanation);
    expect(render({ envelope_version, completeness: { status: "partial", bound: "at_least", note: explanation } }))
      .toContain(explanation);
  });

  it("decodes every condition in a current composed verdict", () => {
    const message = render({ envelope_version: 2, verdict: {
      state: "inconclusive",
      limiting_factor: "absence_coverage_unreported; response_bounded; absence_coverage_unreported",
    } });
    expect(message).toContain("did not report which languages");
    expect(message).toContain("response budget");
    expect(message).toContain("lower bound");
    expect(message).not.toContain("absence_coverage_unreported");
    expect(message).not.toContain("response_bounded");
    expect(message.match(/did not report which languages/g)).toHaveLength(1);
  });

  it("uses the public condition's specific recovery guidance", () => {
    const message = render({ envelope_version: 2, verdict: {
      state: "inconclusive", limiting_factor: "file_bytes_unadmitted; walk_depth_bounded",
    } });
    expect(message).toContain("kin reconcile");
    expect(message).toContain("raise max_depth");
  });

  it("renders bounds, coverage counters and known current limit labels", () => {
    const message = render({ envelope_version: 2,
      completeness: { status: "partial", bound: "at_least", limits: ["embeddings_partial", "response_bounded"] },
      semantic_coverage: { indexed: 7, total: 10, pending: 3, complete: false,
        limited_by: ["embeddings_incomplete", "graph_role_filter", "graph_body_gap"] },
    });
    expect(message).toContain("lower bound");
    expect(message).toContain("7 of 10 embedded, 3 pending");
    expect(message).toContain("eligible entities have not been embedded");
    expect(message).toContain("Test-role source paths were excluded");
    expect(message).toContain("source paths have no body");
    expect(message).not.toMatch(/embeddings_partial|response_bounded|graph_role_filter|graph_body_gap|at_least/);
  });

  it("explains structured edge and degraded labels without certifying absence", () => {
    const message = render({ envelope_version: 2,
      completeness: { status: "unknown", bound: "at_least", limits: [
        "edge_coverage:calls_absent", "edge_coverage:imports_unknown", "degraded:memory_pressure",
      ] },
    });
    expect(message).toContain("calls edges");
    expect(message).toContain("imports coverage was not established");
    expect(message).toContain("machine had no room");
    expect(message).not.toContain("Unknown Kin diagnostic");
  });

  it("explains opaque artifacts without reporting an empty file", () => {
    const message = render({ envelope_version: 2,
      completeness: { status: "partial", bound: "at_least", limits: ["file_content_opaque_no_adapter_for_extension:md"] },
    });
    expect(message).toContain("no language adapter for .md files");
    expect(message).toContain("stores this content without a semantic entity list");
    expect(message).not.toContain("Unknown Kin diagnostic");
  });

  it("retains additive producer notes without hiding unknown current codes", () => {
    const message = render({ envelope_version: 2,
      verdict: { state: "inconclusive", limiting_factor: "future_verdict", note: "Keep this producer explanation." },
      completeness: { status: "partial", bound: "at_least", limits: ["future_limit"], note: "Keep this coverage detail." },
    });
    expect(message).toContain("Keep this producer explanation.");
    expect(message).toContain("Keep this coverage detail.");
    expect(message).toContain('Unknown Kin diagnostic code "future_verdict"');
    expect(message).toContain('Unknown Kin diagnostic code "future_limit"');
  });

  it.each(["new_future_condition", "constructor", "__proto__"])("labels unknown code %s explicitly", (code) => {
    const message = render({ envelope_version: 2, verdict: { state: "inconclusive", limiting_factor: code } });
    expect(message).toContain(`Unknown Kin diagnostic code "${code}"`);
    expect(message).toContain("do not treat this answer as complete");
  });

  it("keeps an unknown condition visible even beside a conclusive verdict or exact count", () => {
    const message = render({ envelope_version: 2,
      verdict: { state: "conclusive", limiting_factor: "future_verdict" },
      completeness: { status: "complete", bound: "exact", limits: ["future_limit"] },
      semantic_coverage: { complete: true, pending: 0, indexed: 10, total: 10, limited_by: ["future_coverage"] },
    });
    for (const code of ["future_verdict", "future_limit", "future_coverage"]) {
      expect(message).toContain(`Unknown Kin diagnostic code "${code}"`);
    }
    expect(message).toContain("do not treat this answer as complete");
  });

  it("does not assume a future version still assigns today's meaning to a code", () => {
    const findings = findingsFromPayload({ _kin: { envelope_version: 3,
      verdict: { state: "conclusive", limiting_factor: "response_bounded" },
      completeness: { status: "complete", bound: "exact" },
    } });
    expect(findings).toContainEqual(expect.objectContaining({ code: "envelope.unsupported_version", severity: "warning" }));
    expect(findings.map((finding) => finding.message).join("\n")).toContain("Unknown Kin diagnostic code");
    expect(findings.map((finding) => finding.message).join("\n")).not.toContain("response budget");
  });

  it("leaves a clean current envelope free of invented findings", () => {
    expect(findingsFromPayload({ _kin: { envelope_version: 2,
      verdict: { state: "conclusive", limiting_factor: null },
      completeness: { status: "complete", bound: "exact", limits: [] },
      semantic_coverage: { complete: true, indexed: 10, total: 10, pending: 0, limited_by: [] },
    } })).toEqual([]);
  });
});
