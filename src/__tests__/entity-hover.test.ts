// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { renderEntityHover } from "../entity-hover";
import type { EntityView } from "../graph-entity";
import { readNeighborhood } from "../graph-relations";

const FOCAL = "focal-id";

function view(overrides: Partial<EntityView> = {}): EntityView {
  return {
    document: {
      entityId: FOCAL,
      name: "app.routes.buildRouter",
      kind: "Function",
      language: "python",
      signature: "def build_router(config)",
      startLine: 20,
      endLine: 44,
      body: "def build_router(config):\n    return Router(config)",
      truncated: false,
      provenance: {
        sourceState: "committed",
        spanCoherence: "proven",
        changeId: "change-1",
        artifactId: "artifact-1",
        readVia: "graph",
      },
    },
    neighborhood: readNeighborhood(
      JSON.stringify({
        focal_id: FOCAL,
        truncated: false,
        entities: [
          { id: "callee", name: "Router", kind: "Class", signature: "class Router" },
        ],
        relations: [
          {
            src: { Entity: FOCAL },
            dst: { Entity: "callee" },
            kind: "Calls",
            direction: "outgoing",
            from: FOCAL,
            resolution: "type_resolved",
          },
        ],
      })
    ),
    findings: [],
    content: "def build_router(config):\n    return Router(config)",
    readAt: 0,
    ...overrides,
  };
}

describe("the entity hover", () => {
  it("leads with the name and kind and carries the signature and span", () => {
    const hover = renderEntityHover(view());

    expect(hover).toContain("**app.routes.buildRouter** · Function");
    expect(hover).toContain("def build_router(config)");
    expect(hover).toContain("Graph span: lines 20 to 44.");
  });

  it("shows graph provenance and no file path", () => {
    const hover = renderEntityHover(view());

    expect(hover).toContain("Source state: committed");
    expect(hover).toContain("Span coherence: proven");
    expect(hover).toContain("Artifact: artifact-1");
    // "Entities never paths": the hover names what the graph owns, and the
    // addressable handle for the bytes is the artifact id, not a file path.
    // `get_entity_source` publishes `file_path` and `read_path`, and neither
    // reaches this surface, so the check is for a path label and for a
    // directory separator inside the provenance line.
    expect(hover).not.toMatch(/\b(File|Path|read_path|file_path)\b/);
    const provenanceLine = hover
      .split("\n")
      .find((line) => line.startsWith("Source state:"));
    expect(provenanceLine).toBeDefined();
    expect(provenanceLine).not.toContain("/");
  });

  it("names uncommitted bytes as uncommitted", () => {
    const hover = renderEntityHover(
      view({
        document: {
          ...view().document,
          provenance: { sourceState: "workspace", workspaceGeneration: 12 },
        },
      })
    );
    expect(hover).toContain("Uncommitted working-tree bytes at workspace generation 12");
  });

  it("lists relations by direction", () => {
    const hover = renderEntityHover(view());
    expect(hover).toContain("Depends on:");
    expect(hover).toContain("Calls Router (Class)");
    expect(hover).toContain("Used by: the graph holds none.");
  });

  it("tells a failed relations read apart from an entity with no relations", () => {
    // The failure this guards: rendering a read that never answered as "no
    // callers", which is a claim about the code rather than about the session.
    const failed = renderEntityHover(view({ neighborhood: undefined }));
    expect(failed).toContain("did not answer");
    expect(failed).toContain("not a claim that the entity has no relations");
    expect(failed).not.toContain("the graph holds none");

    const empty = renderEntityHover(
      view({
        neighborhood: { truncated: false, relations: [] },
      })
    );
    expect(empty).toContain("Depends on: the graph holds none.");
    expect(empty).not.toContain("did not answer");
  });

  it("says when the daemon capped the walk", () => {
    const hover = renderEntityHover(
      view({ neighborhood: { truncated: true, relations: [] } })
    );
    expect(hover).toContain("a floor rather than the whole set");
  });

  it("says a truncated body is truncated", () => {
    const hover = renderEntityHover(
      view({ document: { ...view().document, truncated: true } })
    );
    expect(hover).toContain("**This body is truncated.**");
  });

  it("lists the findings, most severe first, and caps the list", () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({
      code: `c${index}`,
      severity: "info" as const,
      message: `finding ${index}`,
    }));
    const hover = renderEntityHover(view({ findings }));

    expect(hover).toContain("7 findings, most severe first");
    expect(hover).toContain("finding 0");
    expect(hover).toContain("and 2 more, listed in the Problems panel");
    expect(hover).not.toContain("finding 6");
  });

  it("says nothing about findings when there are none", () => {
    expect(renderEntityHover(view())).not.toContain("What the graph disclosed");
  });
});
