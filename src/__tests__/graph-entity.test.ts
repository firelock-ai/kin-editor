// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { join } from "path";
import {
  EntitySourceShapeError,
  TRUNCATION_MARKER,
  groupByNamespaceAndKind,
  isTruncatedBody,
  leafName,
  lineCommentPrefix,
  namespaceGroupLabel,
  namespaceGroupTooltip,
  namespaceOf,
  readEntitySource,
  truncationBanner,
} from "../graph-entity";
import type { KinEntity } from "../kin-client";

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "mcp", "entity-source.json"),
    "utf8"
  )
) as { capture: { provenance: string }; payload: Record<string, unknown> };

function entity(name: string, kind = "Function"): KinEntity {
  return { name, kind, file: "", line: 1 };
}

describe("readEntitySource", () => {
  it("reads the response shape kin's get_entity_source builds", () => {
    // The fixture is constructed from the response builder, not captured, and
    // says so in its own provenance block.
    expect(fixture.capture.provenance).toContain("CONSTRUCTED from kin source");

    const document = readEntitySource(JSON.stringify(fixture.payload));

    expect(document.name).toBe("KinClient::entitySource");
    expect(document.kind).toBe("Method");
    expect(document.language).toBe("rust");
    expect(document.startLine).toBe(412);
    expect(document.endLine).toBe(418);
    expect(document.body).toContain("pub async fn entity_source");
    expect(document.truncated).toBe(false);
    expect(document.provenance).toEqual({
      sourceState: "committed",
      spanCoherence: "proven",
      changeId: "9f2c1b77-3a4e-4c19-8f25-6f1b0d3a8c42",
      artifactId: "b1946ac92492d2347c6235b4d2611184",
      readVia: "graph",
      workspaceGeneration: undefined,
      baseChangeId: undefined,
      workspaceTreeHash: undefined,
    });
  });

  it("reads the uncommitted-body provenance keys, which are a different set", () => {
    // `source_provenance_fields` deliberately does NOT put uncommitted bytes
    // under `source_change_id`, because no change contains them.
    const document = readEntitySource(
      JSON.stringify({
        ...fixture.payload,
        source_state: "workspace",
        source_change_id: undefined,
        workspace_tree_hash: "tree-hash",
        workspace_generation: 42,
        base_change_id: "base-change",
      })
    );

    expect(document.provenance.sourceState).toBe("workspace");
    expect(document.provenance.workspaceGeneration).toBe(42);
    expect(document.provenance.baseChangeId).toBe("base-change");
    expect(document.provenance.changeId).toBeUndefined();
  });

  it("throws rather than rendering an empty document when the shape drifted", () => {
    // A hollow document would show the user an entity with no code and no
    // reason, which is the failure the CLI contract layer exists to prevent on
    // the other paths.
    expect(() => readEntitySource(JSON.stringify({ name: "x" }))).toThrow(
      EntitySourceShapeError
    );
    expect(() => readEntitySource("not json at all")).toThrow(
      EntitySourceShapeError
    );
    try {
      readEntitySource(JSON.stringify({ body: "fn x() {}" }));
      throw new Error("expected a shape error");
    } catch (err) {
      expect((err as EntitySourceShapeError).missing).toEqual(["name"]);
    }
  });

  it("flags a body the daemon marked as cut", () => {
    const document = readEntitySource(
      JSON.stringify({
        ...fixture.payload,
        body: `fn head() {\n${TRUNCATION_MARKER}`,
      })
    );
    expect(document.truncated).toBe(true);
  });

  it("does not flag a body that merely mentions truncation", () => {
    // The marker is what kin appends at the END of a clipped body. A body whose
    // own source talks about truncation is not a cut body, and calling it one
    // would put a false warning over real code.
    expect(isTruncatedBody('let note = "... [truncated]";\nreturn note;')).toBe(
      false
    );
    expect(isTruncatedBody(`fn x() {}\n${TRUNCATION_MARKER}\n`)).toBe(true);
  });
});

describe("the truncation banner", () => {
  it("names the cut, the remedy and the span the graph claims", () => {
    const document = readEntitySource(
      JSON.stringify({ ...fixture.payload, body: `x\n${TRUNCATION_MARKER}` })
    );
    const banner = truncationBanner(document, "//");

    expect(banner).toContain("TRUNCATED");
    expect(banner).toContain("kin_artifact_read");
    expect(banner).toContain("lines 412 to 418");
    expect(banner).toContain(document.entityId);
    for (const line of banner.split("\n").filter((l) => l.length > 0)) {
      expect(line.startsWith("//")).toBe(true);
    }
  });

  it("comments the banner the way the entity's own language does", () => {
    expect(lineCommentPrefix("python")).toBe("#");
    expect(lineCommentPrefix("ruby")).toBe("#");
    expect(lineCommentPrefix("rust")).toBe("//");
    expect(lineCommentPrefix(undefined)).toBe("//");
  });
});

describe("namespaces come from the graph's own names", () => {
  it("splits a qualified name and leaves a bare one alone", () => {
    expect(namespaceOf("kin_client::KinClient::entitySource")).toBe(
      "kin_client::KinClient"
    );
    expect(leafName("kin_client::KinClient::entitySource")).toBe("entitySource");
    expect(namespaceOf("app.routes.build_router")).toBe("app.routes");
    expect(leafName("app.routes.build_router")).toBe("build_router");
    expect(namespaceOf("buildRouter")).toBeUndefined();
    expect(leafName("buildRouter")).toBe("buildRouter");
  });

  it("prefers :: over . so a generic argument does not split a Rust path", () => {
    expect(namespaceOf("kin::store::get<Vec<T>.Item>")).toBe("kin::store");
  });

  it("treats a leading separator as no namespace rather than an empty one", () => {
    expect(namespaceOf("::global")).toBeUndefined();
    expect(namespaceOf(".hidden")).toBeUndefined();
  });
});

describe("grouping by namespace and kind", () => {
  const entities: KinEntity[] = [
    entity("app.routes.build_router"),
    entity("app.routes.Router", "Class"),
    entity("app.db.connect"),
    entity("standalone"),
    entity("alsoStandalone", "Class"),
  ];

  it("groups by the graph's namespace, then by kind, deterministically", () => {
    const groups = groupByNamespaceAndKind(entities);

    expect(groups.map((g) => g.namespace)).toEqual([
      "app.db",
      "app.routes",
      undefined,
    ]);
    const routes = groups[1];
    expect(routes.count).toBe(2);
    expect(routes.kinds.map((k) => k.kind)).toEqual(["Class", "Function"]);
    expect(routes.kinds[1].entities.map((e) => e.name)).toEqual([
      "app.routes.build_router",
    ]);
  });

  it("puts the un-namespaced group last and says why it exists", () => {
    const groups = groupByNamespaceAndKind(entities);
    const last = groups[groups.length - 1];

    expect(last.namespace).toBeUndefined();
    expect(namespaceGroupLabel(last)).toBe("No namespace in the graph");
    // The point of the row: these entities are NOT filed under the folder they
    // happen to live in, and the tooltip says so.
    expect(namespaceGroupTooltip(last)).toContain("never by folder");
    expect(namespaceGroupTooltip(last)).not.toContain("src/");
  });

  it("names an entity with no kind rather than dropping it", () => {
    const groups = groupByNamespaceAndKind([
      { name: "mystery", kind: "", file: "", line: 1 },
    ]);
    expect(groups[0].kinds[0].kind).toBe("Unknown");
  });

  it("returns nothing for no entities", () => {
    expect(groupByNamespaceAndKind([])).toEqual([]);
  });
});
