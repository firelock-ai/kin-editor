// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  formatReferenceLocation,
  formatReferenceSites,
  normalizeReferenceRow,
  readEntityAnchor,
  readReferenceRows,
  referenceTargets,
} from "../graph-references";

const CALLER = "1fcd4028-6a1b-4c2d-8e3f-5a7b9c0d1e2f";

describe("normalizeReferenceRow", () => {
  it("reads the documented row shape: projected file, sites, and the reasons", () => {
    expect(
      normalizeReferenceRow({
        entity_id: CALLER,
        name: "solve_dependencies",
        kind: "Function",
        role: "source",
        projection: { path: "fastapi/dependencies/utils.py" },
        site_count: 2,
        sites: [
          { line_in_entity: 43, callee: "get_dependant" },
          { line_in_entity: 50, callee: null, callee_unavailable: "caller_source_unavailable" },
        ],
        sites_absent_reason: null,
        sites_partial_reason: "incomplete_call_evidence",
        relation_kinds: ["calls"],
        resolution: "type_resolved",
        via_override_of: null,
      })
    ).toEqual({
      id: CALLER,
      kind: "Function",
      name: "solve_dependencies",
      file: "fastapi/dependencies/utils.py",
      sites: [
        { lineInEntity: 43, callee: "get_dependant" },
        { lineInEntity: 50, callee: null, calleeUnavailable: "caller_source_unavailable" },
      ],
      sitesPartialReason: "incomplete_call_evidence",
    });
  });

  it("gives a row that serves no line no line", () => {
    const reference = normalizeReferenceRow({
      entity_id: CALLER,
      name: "caller",
      projection: { path: "src/caller.ts" },
      sites: [],
    });
    expect(reference.line).toBeUndefined();
  });
});

describe("readReferenceRows", () => {
  it("reads the references array and leaves every other section to the daemon", () => {
    const rows = readReferenceRows(
      JSON.stringify({
        focal_entity: { name: "target", projection: { path: "src/target.ts" } },
        references: [{ entity_id: CALLER, name: "caller", projection: { path: "src/caller.ts" } }],
        candidates: [{ entity_id: "other", name: "maybe", projection: { path: "src/maybe.ts" } }],
      })
    );
    expect(rows?.map((row) => row.name)).toEqual(["caller"]);
  });

  it("answers undefined for a reply with no references array", () => {
    expect(readReferenceRows(JSON.stringify({ focal_entity: { name: "x" } }))).toBeUndefined();
    expect(readReferenceRows("not json")).toBeUndefined();
  });
});

describe("readEntityAnchor", () => {
  it("reads the 0-based span start and the 1-based start line from a get_entity record", () => {
    expect(
      readEntityAnchor(JSON.stringify({ id: CALLER, span: { start_line: 0 }, start_line: 1 }), CALLER)
    ).toEqual({ spanStartLine: 0, startLine: 1 });
  });

  it("refuses a record for another entity", () => {
    expect(
      readEntityAnchor(JSON.stringify({ id: "someone-else", span: { start_line: 4 } }), CALLER)
    ).toBeUndefined();
  });
});

describe("referenceTargets", () => {
  const reference = normalizeReferenceRow({
    entity_id: CALLER,
    name: "caller",
    projection: { path: "src/caller.ts" },
    sites: [
      { line_in_entity: 0, callee: "target" },
      { line_in_entity: 0, callee: "target" },
      { line_in_entity: 9, callee: "target" },
    ],
  });

  it("puts each site at span start + 1 + line_in_entity, once per line", () => {
    expect(
      referenceTargets(reference, { spanStartLine: 0, startLine: 1 }).map((target) => target.line)
    ).toEqual([1, 10]);
  });

  it("derives no line without a record", () => {
    expect(referenceTargets(reference, undefined)).toEqual([{ file: "src/caller.ts" }]);
  });
});

describe("formatting a reference", () => {
  it("shows sites inside the caller as +N callee, and says when there may be more", () => {
    const reference = normalizeReferenceRow({
      entity_id: CALLER,
      name: "caller",
      projection: { path: "src/caller.ts" },
      sites: [
        { line_in_entity: 4, callee: "target" },
        { line_in_entity: 7, callee: null, callee_unavailable: "caller_source_unavailable" },
        { line_in_entity: null, callee: "target" },
      ],
      sites_partial_reason: "language_server_edge",
    });
    expect(formatReferenceSites(reference)).toBe(
      "+4 target, +7, outside the caller's span target (may be more: language_server_edge)"
    );
    expect(formatReferenceLocation(reference)).toBe("src/caller.ts");
  });

  it("names why a row has no sites", () => {
    const reference = normalizeReferenceRow({
      entity_id: CALLER,
      name: "caller",
      projection: { path: "src/caller.ts" },
      sites: [],
      sites_absent_reason: "no_evidence_span",
    });
    expect(formatReferenceSites(reference)).toBe("no sites (no_evidence_span)");
  });

  it("shows a served line as served", () => {
    expect(
      formatReferenceLocation({ kind: "Function", name: "caller", file: "src/caller.ts", line: 7 })
    ).toBe("src/caller.ts:7");
  });
});
