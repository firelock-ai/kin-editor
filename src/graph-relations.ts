// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Reading `graph_neighborhood` into the relations one entity actually has.
// Pure, so the joining logic is asserted directly rather than through a hover.

/** One endpoint of a relation, as far as the graph would name it. */
export interface RelationNeighbor {
  /** Set when the endpoint is an entity, which is the only addressable case. */
  id?: string;
  name?: string;
  kind?: string;
  signature?: string;
  /**
   * Set when the endpoint is NOT an entity. `GraphNodeId` is a typed node
   * reference and only one of its variants is an entity; the rest (an artifact,
   * an external reference to a symbol owned outside this repository) have no
   * entity row to join to. Naming the variant is the honest rendering: the
   * relation is real, and the thing on the other end is not something this
   * viewer can open.
   */
  externalKind?: string;
}

/** One edge, with the endpoint that is not the focal resolved where possible. */
export interface GraphRelation {
  /** The relation kind as the graph spells it, e.g. "Calls", "Imports". */
  kind: string;
  direction: "incoming" | "outgoing";
  /**
   * The daemon's own resolution label. A `name_only` edge was matched by name
   * alone and is a candidate rather than a fact, which is exactly the thing a
   * reader must not be shown unmarked.
   */
  resolution?: string;
  neighbor: RelationNeighbor;
}

/** What `graph_neighborhood` said about one entity's surroundings. */
export interface EntityNeighborhood {
  focalId?: string;
  direction?: string;
  depth?: number;
  entityCount?: number;
  relationCount?: number;
  /** The daemon capped the walk, so this is a floor rather than the whole set. */
  truncated: boolean;
  relations: GraphRelation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read one `GraphNodeId` endpoint.
 *
 * `GraphNodeId` is an externally tagged serde enum, so an entity endpoint
 * arrives as `{"Entity": "<uuid>"}` and every other variant as its own single
 * key. Returning the variant name for the others is what lets a relation to an
 * external symbol render as a relation rather than disappear.
 */
export function readEndpoint(
  value: unknown
): { entityId?: string; variant?: string } {
  if (typeof value === "string") {
    // A daemon that flattens the endpoint to a bare id. Read it as an entity id
    // rather than losing the edge; a stale id simply resolves to nothing below.
    return { entityId: value };
  }
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    // Not the tagged shape. Fall back to the keys a flattened endpoint uses.
    const id = str(value.entity_id) ?? str(value.id);
    return id ? { entityId: id } : {};
  }
  const [variant, payload] = entries[0];
  if (variant === "Entity") {
    const id = str(payload);
    return id ? { entityId: id } : { variant };
  }
  return { variant };
}

/**
 * Read a `graph_neighborhood` payload into the focal's own relations.
 *
 * Only depth-1 edges are kept: an edge whose `from` is not the focal was
 * traversed from a neighbor, so listing it beside the focal's own would tell a
 * reader this entity calls something two hops away. The walk is still asked for
 * at depth 1, so this is a guard rather than the mechanism.
 */
export function readNeighborhood(raw: string): EntityNeighborhood {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { truncated: false, relations: [] };
  }
  if (!isRecord(parsed)) {
    return { truncated: false, relations: [] };
  }

  const focalId = str(parsed.focal_id);
  const byId = new Map<string, RelationNeighbor>();
  if (Array.isArray(parsed.entities)) {
    for (const entry of parsed.entities) {
      if (!isRecord(entry)) {
        continue;
      }
      const id = str(entry.id);
      if (!id) {
        continue;
      }
      byId.set(id, {
        id,
        name: str(entry.name),
        kind: str(entry.kind),
        signature: str(entry.signature),
      });
    }
  }

  const relations: GraphRelation[] = [];
  if (Array.isArray(parsed.relations)) {
    for (const entry of parsed.relations) {
      if (!isRecord(entry)) {
        continue;
      }
      const direction = str(entry.direction);
      if (direction !== "incoming" && direction !== "outgoing") {
        continue;
      }
      const from = str(entry.from);
      if (focalId && from && from !== focalId) {
        continue;
      }
      // The walk tags an edge by which endpoint it expanded, so the neighbor is
      // the far end of that traversal.
      const far = direction === "outgoing" ? entry.dst : entry.src;
      const endpoint = readEndpoint(far);
      const neighbor: RelationNeighbor = endpoint.entityId
        ? (byId.get(endpoint.entityId) ?? { id: endpoint.entityId })
        : { externalKind: endpoint.variant ?? "unknown node" };
      relations.push({
        kind: str(entry.kind) ?? "Relation",
        direction,
        resolution: str(entry.resolution),
        neighbor,
      });
    }
  }

  relations.sort((a, b) => {
    if (a.direction !== b.direction) {
      return a.direction === "outgoing" ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }
    return (a.neighbor.name ?? a.neighbor.id ?? "").localeCompare(
      b.neighbor.name ?? b.neighbor.id ?? ""
    );
  });

  return {
    focalId,
    direction: str(parsed.direction),
    depth: num(parsed.depth),
    entityCount: num(parsed.entity_count),
    relationCount: num(parsed.relation_count),
    truncated: parsed.truncated === true,
    relations,
  };
}

/** One relation rendered as a line, e.g. "calls parseEntitySource (Function)". */
export function describeRelation(relation: GraphRelation): string {
  const verb = relation.direction === "outgoing" ? relation.kind : `${relation.kind} by`;
  const neighbor = relation.neighbor;
  const subject = neighbor.name
    ? neighbor.kind
      ? `${neighbor.name} (${neighbor.kind})`
      : neighbor.name
    : neighbor.externalKind
      ? `a ${neighbor.externalKind} outside this repository`
      : (neighbor.id ?? "an entity the graph did not return");
  return `${verb} ${subject}${resolutionSuffix(relation.resolution)}`;
}

/**
 * How an edge's resolution is annotated.
 *
 * `kin_index::RelationResolution` publishes three wire names and only
 * `type_resolved` is proven: `name_only` was matched by a bare name across the
 * repository and is a candidate, `import_scoped` was selected inside a known
 * module scope. An unmarked candidate presented beside a proven edge is the
 * shape of wrong answer this annotation exists to stop, so the proven one is
 * the only one that renders silently.
 */
export function resolutionSuffix(resolution?: string): string {
  switch (resolution) {
    case undefined:
    case "type_resolved":
      return "";
    case "name_only":
      return " [name match only, a candidate rather than a proven edge]";
    case "import_scoped":
      return " [resolved within an imported scope]";
    default:
      return ` [${resolution}]`;
  }
}
