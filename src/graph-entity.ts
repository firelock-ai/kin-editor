// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Reading the graph's own answers about one entity, and grouping entities the
// way the graph names them. No `vscode` import, so every decision here is
// asserted directly rather than through a mocked editor.

import type { KinEntity } from "./kin-client";
import type { GraphFinding } from "./graph-findings";
import type { EntityNeighborhood } from "./graph-relations";

/**
 * The marker `kin` writes where it clipped a rendered body.
 *
 * Measured on kin `origin/main` at 8021c785b: `clip_rendered_text_with_cap`
 * (`crates/kin-mcp/src/handlers/common.rs`) appends exactly this after cutting
 * at `MCP_SOURCE_MAX_LINES` (40) or `MCP_SOURCE_MAX_CHARS` (2400), and those
 * bounds are what `get_context_pack.focal_entity.body` and `get_entity`'s
 * `source_excerpt` carry.
 *
 * `get_entity_source` on that same head does NOT clip: it reads the exact span
 * and REFUSES a body over its byte limit with a message naming
 * `kin_artifact_read`. The viewer reads bodies from there for exactly that
 * reason. The marker is still detected, because a daemon older or newer than
 * the one measured may clip the tool this viewer reads, and a silently cut body
 * presented as an entity's source is the failure this check exists to prevent.
 */
export const TRUNCATION_MARKER = "... [truncated]";

/** Where a body came from and whether its span can be trusted to describe it. */
export interface EntityProvenance {
  /** The daemon's `source_state` label, e.g. "committed" or "workspace". */
  sourceState?: string;
  /** The daemon's `span_coherence` label. */
  spanCoherence?: string;
  /** Set when the body is committed: the change that contains these bytes. */
  changeId?: string;
  /** Set when the body is uncommitted working-tree content. */
  workspaceGeneration?: number;
  baseChangeId?: string;
  workspaceTreeHash?: string;
  /** Content-addressed id of the artifact the span was read out of. */
  artifactId?: string;
  /** The daemon's own `source` label, e.g. "graph" or "graph-miss". */
  readVia?: string;
}

/** One entity's body and metadata, as `get_entity_source` answered it. */
export interface EntitySourceDocument {
  entityId: string;
  name: string;
  kind: string;
  language?: string;
  signature?: string;
  startLine?: number;
  endLine?: number;
  /** The entity's body exactly as the graph served it. */
  body: string;
  /** True when the body carries the daemon's own truncation marker. */
  truncated: boolean;
  provenance: EntityProvenance;
}

/**
 * Everything one open `kin://` document knows about its entity.
 *
 * Declared here rather than beside the provider so the hover renderer can be
 * asserted without an editor. `neighborhood` is absent when the relations read
 * did not answer, which the hover has to say rather than render as "no
 * relations": those are different facts and only one of them is about the code.
 */
export interface EntityView {
  document: EntitySourceDocument;
  neighborhood?: EntityNeighborhood;
  findings: GraphFinding[];
  /** The bytes handed to the editor: the body plus any truncation banner. */
  content: string;
  readAt: number;
}

/** A response this extension could not read as an entity source. */
export class EntitySourceShapeError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], detail: string) {
    super(
      `The Kin daemon answered get_entity_source in a shape this extension cannot read. ` +
        `Missing: ${missing.join(", ")}. ${detail}`
    );
    this.name = "EntitySourceShapeError";
    this.missing = missing;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a `get_entity_source` payload.
 *
 * Throws rather than returning a hollow document when the two sides have
 * drifted, because a viewer that renders an empty body for a drifted answer
 * shows the user an entity with no code and no reason. `body` and `name` are
 * the two keys a document cannot be built without; everything else degrades to
 * absent.
 */
export function readEntitySource(raw: string): EntitySourceDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EntitySourceShapeError(
      ["body", "name"],
      `The response was not JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new EntitySourceShapeError(
      ["body", "name"],
      "The response was not a JSON object."
    );
  }

  const missing: string[] = [];
  if (typeof parsed.body !== "string") {
    missing.push("body");
  }
  if (typeof parsed.name !== "string") {
    missing.push("name");
  }
  if (missing.length > 0) {
    throw new EntitySourceShapeError(
      missing,
      "A document cannot be built without the entity's body and name."
    );
  }

  const body = parsed.body as string;
  return {
    entityId: optionalString(parsed.id) ?? "",
    name: parsed.name as string,
    kind: optionalString(parsed.kind) ?? "Unknown",
    language: optionalString(parsed.language),
    signature: optionalString(parsed.signature),
    startLine: optionalNumber(parsed.start_line),
    endLine: optionalNumber(parsed.end_line),
    body,
    truncated: isTruncatedBody(body),
    provenance: {
      sourceState: optionalString(parsed.source_state),
      spanCoherence: optionalString(parsed.span_coherence),
      changeId: optionalString(parsed.source_change_id),
      workspaceGeneration: optionalNumber(parsed.workspace_generation),
      baseChangeId: optionalString(parsed.base_change_id),
      workspaceTreeHash: optionalString(parsed.workspace_tree_hash),
      artifactId: optionalString(parsed.artifact_id),
      readVia: optionalString(parsed.source),
    },
  };
}

/** Whether a body carries the daemon's truncation marker. */
export function isTruncatedBody(body: string): boolean {
  return body.trimEnd().endsWith(TRUNCATION_MARKER);
}

/**
 * The banner a truncated body gets, naming the cut and how to read the rest.
 *
 * Appended to the document rather than replacing the body, because the lines
 * that DID arrive are still the entity's source and a user reading them should
 * keep them. What they must not do is believe the last line is the entity's
 * last line, and this says so in the buffer they are looking at rather than in
 * a notification they may never see.
 */
export function truncationBanner(
  document: EntitySourceDocument,
  commentPrefix: string
): string {
  const lines = [
    "",
    `${commentPrefix} Kin: this body is TRUNCATED. The daemon cut it and marked the cut with`,
    `${commentPrefix} "${TRUNCATION_MARKER}", so what you see above is not the whole entity.`,
    `${commentPrefix} Read the whole body with: kin_artifact_read, or get_entity_source on a`,
    `${commentPrefix} daemon that serves the exact span.`,
  ];
  if (document.startLine !== undefined && document.endLine !== undefined) {
    lines.push(
      `${commentPrefix} The graph says this entity spans lines ${document.startLine} to ${document.endLine}.`
    );
  }
  if (document.entityId) {
    lines.push(`${commentPrefix} Entity id: ${document.entityId}`);
  }
  return lines.join("\n");
}

/**
 * The line-comment prefix for a Kin language id.
 *
 * `#` for the hash-comment languages this build parses, `//` otherwise. The
 * banner is the only text this extension ever adds to a body, and it is added
 * only to a body the daemon already cut, so the worst case of a wrong guess is
 * an unhighlighted banner under a body that is already not compilable.
 */
export function lineCommentPrefix(language?: string): string {
  switch ((language ?? "").toLowerCase()) {
    case "python":
    case "ruby":
    case "hcl":
      return "#";
    default:
      return "//";
  }
}

/**
 * The namespace the GRAPH gave an entity, or `undefined` when it gave none.
 *
 * Read out of the entity's own qualified name, never out of its file path. A
 * name with no separator has no namespace here, and the tree says so with a
 * group that names the absence rather than borrowing a folder to stand in for
 * one: a folder is exactly the file-first organisation the graph browser
 * exists to replace.
 *
 * `::` wins over `.` when both appear, because a Rust path segment cannot
 * contain a dot while a generic argument inside one can contain anything.
 */
export function namespaceOf(name: string): string | undefined {
  const separator = name.includes("::") ? "::" : name.includes(".") ? "." : undefined;
  if (!separator) {
    return undefined;
  }
  const index = name.lastIndexOf(separator);
  if (index <= 0) {
    return undefined;
  }
  const namespace = name.slice(0, index);
  return namespace.length > 0 ? namespace : undefined;
}

/** The last segment of a qualified name, which is what a tree row shows. */
export function leafName(name: string): string {
  const namespace = namespaceOf(name);
  if (!namespace) {
    return name;
  }
  const separator = name.includes("::") ? "::" : ".";
  return name.slice(namespace.length + separator.length);
}

/** A kind group inside one namespace. */
export interface KindGroup {
  kind: string;
  entities: KinEntity[];
}

/** One namespace, with its entities grouped by kind. */
export interface NamespaceGroup {
  /** `undefined` when the graph published no namespace for these entities. */
  namespace: string | undefined;
  kinds: KindGroup[];
  count: number;
}

/**
 * Group entities by the namespace their names carry and then by kind.
 *
 * Sorting is deterministic so the tree does not reshuffle between refreshes:
 * named namespaces alphabetically, then the un-namespaced group last, kinds
 * alphabetically inside each, entities by their leaf name.
 */
export function groupByNamespaceAndKind(
  entities: readonly KinEntity[]
): NamespaceGroup[] {
  const byNamespace = new Map<string, Map<string, KinEntity[]>>();
  const UNNAMESPACED = " ";

  for (const entity of entities) {
    const namespace = namespaceOf(entity.name) ?? UNNAMESPACED;
    const kind = entity.kind || "Unknown";
    let kinds = byNamespace.get(namespace);
    if (!kinds) {
      kinds = new Map();
      byNamespace.set(namespace, kinds);
    }
    const bucket = kinds.get(kind);
    if (bucket) {
      bucket.push(entity);
    } else {
      kinds.set(kind, [entity]);
    }
  }

  const groups: NamespaceGroup[] = [];
  for (const [namespace, kinds] of byNamespace) {
    const kindGroups: KindGroup[] = [];
    let count = 0;
    for (const [kind, bucket] of kinds) {
      bucket.sort((a, b) => leafName(a.name).localeCompare(leafName(b.name)));
      count += bucket.length;
      kindGroups.push({ kind, entities: bucket });
    }
    kindGroups.sort((a, b) => a.kind.localeCompare(b.kind));
    groups.push({
      namespace: namespace === UNNAMESPACED ? undefined : namespace,
      kinds: kindGroups,
      count,
    });
  }

  return groups.sort((a, b) => {
    if (a.namespace === undefined) {
      return b.namespace === undefined ? 0 : 1;
    }
    if (b.namespace === undefined) {
      return -1;
    }
    return a.namespace.localeCompare(b.namespace);
  });
}

/** The label a namespace group shows, including the absence case. */
export function namespaceGroupLabel(group: NamespaceGroup): string {
  return group.namespace ?? "No namespace in the graph";
}

/** The tooltip a namespace group shows. */
export function namespaceGroupTooltip(group: NamespaceGroup): string {
  if (group.namespace) {
    return `${group.count} ${group.count === 1 ? "entity" : "entities"} the graph names under ${group.namespace}.`;
  }
  return (
    `${group.count} ${group.count === 1 ? "entity" : "entities"} whose graph name carries no namespace. ` +
    `Kin groups by the name the graph published, never by folder, so these are listed together rather ` +
    `than filed under a directory.`
  );
}
