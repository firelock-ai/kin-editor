// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Reading `find_references` rows, and turning one into a place the editor can
// open.
//
// A row addresses its caller by entity id and carries no file line. The file it
// names is `projection.path`, the file the caller is projected into, and each
// usage inside the caller is a site whose `line_in_entity` counts from 0 at the
// caller's first line. The editor is where a file gets opened, so it may turn
// that into a file position, but only from the caller's own entity record
// (`get_entity`): a site's 1-based file line is the record's 0-based
// `span.start_line` plus 1 plus `line_in_entity`, and the caller's own line is
// the record's 1-based `start_line`. Nothing here reads the working tree or
// guesses a line from text, and a position the record cannot give is left out
// rather than filled in.
//
// Pure, so the arithmetic is asserted directly rather than through a jump.

/** One usage of the focal inside a caller, addressed inside that caller. */
export interface KinReferenceSite {
  /**
   * The site's line counted from 0 at the caller's first line. Null when the
   * site lies outside the caller's span, which leaves it no line to count.
   */
  lineInEntity: number | null;
  /**
   * The text at the site, cut from the caller's own body with a call's
   * argument list left out. Null when it could not be read.
   */
  callee: string | null;
  /** Why `callee` is null, as the daemon named it. */
  calleeUnavailable?: string;
}

/**
 * One caller of a traced symbol.
 *
 * From `find_references` this is a row addressed by `id`, with `file` holding
 * the row's `projection.path` and no `line`: the position is resolved from the
 * caller's entity record when the user opens it. The CLI `kin trace` fallback,
 * and a daemon from before rows became entity-relative, serve the caller's
 * 1-based line directly, and that line is kept as served.
 */
export interface KinReference {
  kind: string;
  name: string;
  /**
   * The file the caller is projected into. A projection of the caller, never
   * its address; the address is `id`.
   */
  file: string;
  /** The caller's 1-based line, only when the answer itself served one. */
  line?: number;
  signature?: string;
  /** The caller's entity id. Absent for a federated row from another graph. */
  id?: string;
  language?: string;
  /** Each usage inside the caller. Present on `find_references` rows. */
  sites?: KinReferenceSite[];
  /** Why `sites` is empty, when the daemon said. */
  sitesAbsentReason?: string;
  /** Why the sites that came back may not be all of them. */
  sitesPartialReason?: string;
}

/** The two positions a caller's entity record carries. */
export interface EntityAnchor {
  /** `span.start_line`: 0-based graph truth for the caller's first line. */
  spanStartLine?: number;
  /** `start_line`: the caller's 1-based presentation line. */
  startLine?: number;
}

/** A place to open one reference: a site inside the caller, or the caller. */
export interface ReferenceTarget {
  /** The projection path the caller lives in. */
  file: string;
  /** 1-based file line. Absent when no position could be derived. */
  line?: number;
  /** The site this target lands on. Absent for a caller-level target. */
  site?: KinReferenceSite;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lineIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function readSite(value: unknown): KinReferenceSite {
  const site = isRecord(value) ? value : {};
  const calleeUnavailable = str(site.callee_unavailable);
  return {
    lineInEntity: lineIndex(site.line_in_entity) ?? null,
    callee: str(site.callee) ?? null,
    ...(calleeUnavailable ? { calleeUnavailable } : {}),
  };
}

/**
 * Read one `find_references` row.
 *
 * The file is `projection.path`. A daemon from before rows became
 * entity-relative served `file_path` and the caller's 1-based `start_line`, and
 * those are read as served so an editor ahead of its daemon still opens the
 * caller. A row that serves no line gets none here.
 */
export function normalizeReferenceRow(raw: unknown): KinReference {
  const row = isRecord(raw) ? raw : {};
  const projection = isRecord(row.projection) ? row.projection : {};
  const servedLine = lineIndex(row.start_line);
  const id = str(row.entity_id) ?? str(row.id);
  const signature = str(row.signature);
  const language = str(row.language);
  const absent = str(row.sites_absent_reason);
  const partial = str(row.sites_partial_reason);
  return {
    kind: str(row.kind) ?? "Unknown",
    name: str(row.name) ?? "",
    file: str(projection.path) ?? str(row.file_path) ?? "",
    ...(servedLine !== undefined && servedLine > 0 ? { line: servedLine } : {}),
    ...(signature ? { signature } : {}),
    ...(id ? { id } : {}),
    ...(language ? { language } : {}),
    ...(Array.isArray(row.sites) ? { sites: row.sites.map(readSite) } : {}),
    ...(absent ? { sitesAbsentReason: absent } : {}),
    ...(partial ? { sitesPartialReason: partial } : {}),
  };
}

/**
 * Read the `references` rows of a `find_references` reply, or undefined when
 * the reply has no `references` array to read.
 */
export function readReferenceRows(raw: string): KinReference[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.references)) {
    return undefined;
  }
  return parsed.references
    .map(normalizeReferenceRow)
    .filter((reference) => reference.name || reference.file);
}

/**
 * Read the caller's two positions from its `get_entity` record.
 *
 * Returns undefined for a reply that is not an entity record, or a record for
 * some other entity than the one asked for, so a mismatched answer can never
 * move a jump.
 */
export function readEntityAnchor(
  raw: string,
  entityId: string
): EntityAnchor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const recordId = str(parsed.id);
  if (recordId !== undefined && recordId !== entityId) {
    return undefined;
  }
  const span = isRecord(parsed.span) ? parsed.span : {};
  const spanStartLine = lineIndex(span.start_line);
  const startLine = lineIndex(parsed.start_line);
  return {
    ...(spanStartLine !== undefined ? { spanStartLine } : {}),
    ...(startLine !== undefined && startLine > 0 ? { startLine } : {}),
  };
}

/**
 * Where to open one reference.
 *
 * A line the answer served is used as served. Otherwise each site with a
 * `line_in_entity` becomes a target at the record's `span.start_line` + 1 +
 * `line_in_entity`; with no such site the one target is the caller itself, at
 * the record's `start_line`. Without a record, or with a record that has no
 * span, the target is the projected file with no line.
 */
export function referenceTargets(
  reference: KinReference,
  anchor: EntityAnchor | undefined
): ReferenceTarget[] {
  if (reference.line !== undefined) {
    return [{ file: reference.file, line: reference.line }];
  }
  const targets: ReferenceTarget[] = [];
  const spanStart = anchor?.spanStartLine;
  if (spanStart !== undefined) {
    const seen = new Set<number>();
    for (const site of reference.sites ?? []) {
      if (site.lineInEntity === null) {
        continue;
      }
      const line = spanStart + 1 + site.lineInEntity;
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      targets.push({ file: reference.file, line, site });
    }
  }
  if (targets.length > 0) {
    return targets;
  }
  const callerLine = anchor?.startLine;
  return [
    {
      file: reference.file,
      ...(callerLine !== undefined ? { line: callerLine } : {}),
    },
  ];
}

/** One site as a reader sees it inside its caller: `+N callee`. */
export function formatReferenceSite(site: KinReferenceSite): string {
  const offset =
    site.lineInEntity === null ? "outside the caller's span" : `+${site.lineInEntity}`;
  return site.callee ? `${offset} ${site.callee}` : offset;
}

/**
 * Every site of a reference, each inside its caller. Undefined when the answer
 * carried no sites at all, as the CLI fallback does not.
 */
export function formatReferenceSites(reference: KinReference): string | undefined {
  if (!reference.sites) {
    return undefined;
  }
  if (reference.sites.length === 0) {
    return reference.sitesAbsentReason
      ? `no sites (${reference.sitesAbsentReason})`
      : "no sites";
  }
  const sites = reference.sites.map(formatReferenceSite).join(", ");
  return reference.sitesPartialReason
    ? `${sites} (may be more: ${reference.sitesPartialReason})`
    : sites;
}

/**
 * Where a reference lives, as far as the answer said. A served line is shown;
 * a `find_references` row shows only its projected file, because it carries no
 * file line and any line shown here would be one this editor derived.
 */
export function formatReferenceLocation(reference: KinReference): string {
  return reference.line !== undefined
    ? `${reference.file}:${reference.line}`
    : reference.file;
}
