// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import {
  describeRelation,
  readEndpoint,
  readNeighborhood,
  resolutionSuffix,
} from "../graph-relations";

const FOCAL = "focal-id";

// The shape `handle_graph_neighborhood` builds on kin origin/main at 8021c785b:
// `focal_id`, `direction`, `depth`, `entity_count`, `relation_count`,
// `truncated`, compact entity summaries, and relations whose `src`/`dst` are
// externally tagged `GraphNodeId` values.
const payload = {
  focal_id: FOCAL,
  direction: "both",
  depth: 1,
  entity_count: 3,
  relation_count: 3,
  truncated: false,
  entities: [
    { id: FOCAL, name: "buildRouter", kind: "Function", signature: "fn()" },
    { id: "callee-id", name: "parseConfig", kind: "Function", signature: "fn()" },
    { id: "caller-id", name: "main", kind: "Function", signature: "fn()" },
  ],
  relations: [
    {
      src: { Entity: FOCAL },
      dst: { Entity: "callee-id" },
      kind: "Calls",
      direction: "outgoing",
      from: FOCAL,
      resolution: "type_resolved",
    },
    {
      src: { Entity: "caller-id" },
      dst: { Entity: FOCAL },
      kind: "Calls",
      direction: "incoming",
      from: FOCAL,
      resolution: "name_only",
    },
    {
      src: { Entity: FOCAL },
      dst: { ExternalReference: "ext-1" },
      kind: "Imports",
      direction: "outgoing",
      from: FOCAL,
      resolution: "import_scoped",
    },
  ],
};

describe("readNeighborhood", () => {
  it("joins each edge to the endpoint that is not the focal", () => {
    const neighborhood = readNeighborhood(JSON.stringify(payload));

    expect(neighborhood.focalId).toBe(FOCAL);
    expect(neighborhood.relations).toHaveLength(3);

    const outgoingCall = neighborhood.relations.find(
      (relation) => relation.kind === "Calls" && relation.direction === "outgoing"
    );
    expect(outgoingCall?.neighbor.name).toBe("parseConfig");

    const incomingCall = neighborhood.relations.find(
      (relation) => relation.kind === "Calls" && relation.direction === "incoming"
    );
    // The far end of an incoming edge is its source, and reading `dst` here
    // would put the focal in its own caller list.
    expect(incomingCall?.neighbor.name).toBe("main");
  });

  it("keeps a relation whose far endpoint is not an entity, and names what it is", () => {
    const neighborhood = readNeighborhood(JSON.stringify(payload));
    const imports = neighborhood.relations.find(
      (relation) => relation.kind === "Imports"
    );

    expect(imports?.neighbor.name).toBeUndefined();
    expect(imports?.neighbor.externalKind).toBe("ExternalReference");
    // The exact line, because the old wording put the variant name after an
    // article ("a ExternalReference", "a Artifact"), and two of the six
    // GraphNodeId variants that are not entities start with a vowel.
    expect(describeRelation(imports!)).toBe(
      "Imports a node outside this repository (ExternalReference) [resolved within an imported scope]"
    );
  });

  it("drops an edge traversed from a neighbor rather than from the focal", () => {
    // A depth-2 edge listed beside the focal's own would tell a reader this
    // entity calls something two hops away.
    const neighborhood = readNeighborhood(
      JSON.stringify({
        ...payload,
        relations: [
          ...payload.relations,
          {
            src: { Entity: "callee-id" },
            dst: { Entity: "far-id" },
            kind: "Calls",
            direction: "outgoing",
            from: "callee-id",
            resolution: "type_resolved",
          },
        ],
      })
    );
    expect(neighborhood.relations).toHaveLength(3);
  });

  it("carries the daemon's own truncation flag", () => {
    expect(readNeighborhood(JSON.stringify(payload)).truncated).toBe(false);
    expect(
      readNeighborhood(JSON.stringify({ ...payload, truncated: true })).truncated
    ).toBe(true);
  });

  it("reads an empty neighborhood out of an answer it cannot parse", () => {
    expect(readNeighborhood("not json")).toEqual({
      truncated: false,
      relations: [],
    });
  });
});

describe("readEndpoint", () => {
  it("reads the externally tagged entity variant", () => {
    expect(readEndpoint({ Entity: "abc" })).toEqual({ entityId: "abc" });
  });

  it("names a non-entity variant instead of losing the edge", () => {
    expect(readEndpoint({ Artifact: "a" })).toEqual({ variant: "Artifact" });
  });

  it("reads a flattened endpoint too", () => {
    expect(readEndpoint("abc")).toEqual({ entityId: "abc" });
    expect(readEndpoint({ entity_id: "abc", extra: 1 })).toEqual({
      entityId: "abc",
    });
  });

  it("reads nothing out of something it does not recognise", () => {
    expect(readEndpoint(null)).toEqual({});
    expect(readEndpoint({ a: 1, b: 2 })).toEqual({});
  });
});

describe("how an edge's resolution is shown", () => {
  it("marks a name match as a candidate and leaves a proven edge unmarked", () => {
    // `name_only` was matched by a bare name across the repository. Rendering
    // it like a proven edge is exactly the unmarked guess kin publishes the
    // label to prevent.
    expect(resolutionSuffix("type_resolved")).toBe("");
    expect(resolutionSuffix(undefined)).toBe("");
    expect(resolutionSuffix("name_only")).toContain("candidate");
    expect(resolutionSuffix("import_scoped")).toContain("imported scope");
    expect(resolutionSuffix("something_new")).toBe(" [something_new]");
  });

  it("renders a relation line with its neighbor's name and kind", () => {
    const neighborhood = readNeighborhood(JSON.stringify(payload));
    const incoming = neighborhood.relations.find(
      (relation) => relation.direction === "incoming"
    )!;
    expect(describeRelation(incoming)).toBe(
      "Calls by main (Function) [name match only, a candidate rather than a proven edge]"
    );
  });
});
