// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// The CLI fallback contract.
//
// Every query in this extension is MCP-first with a CLI fallback. The fallback
// is what answers before `kin setup` has wired an MCP client and whenever that
// connection is down, which is exactly the state a first-time user is in. So
// the fallback is not a rare degraded path; it is the first-run path.
//
// A `kin <command> --json` call that succeeds but answers in a shape the reader
// does not expect is the dangerous case: the process exits 0, the JSON parses,
// and every field the reader wants comes back `undefined`. Nothing throws and
// the panes render a confident empty graph. This module turns that silence into
// one named warning by declaring, per command, which keys the reader needs and
// how the answer maps onto the extension's own types.
//
// Every expected key set here was measured against a real `kin 0.6.0` build.
// The measured payloads are checked in under `src/__tests__/fixtures/cli/` and
// the contract tests drive these readers with those bytes.

import type {
  GraphAvailability,
  KinEntity,
  KinOverview,
  KinReviewFinding,
  KinReviewResult,
  KinStatus,
} from "./kin-client";

export type CliCommandId = "status" | "overview" | "search" | "trace" | "review";

/**
 * Why a CLI answer could not be read. Each cause gets its own value, because a
 * reader that reports "the contract broke" without saying which way it broke
 * cannot tell a caller whether to retry, and a test asserting only the field
 * cannot tell two causes apart.
 */
export type ContractDriftReason =
  | "wrong-top-level-type"
  | "missing-top-level-keys"
  | "missing-nested-keys"
  | "missing-element-keys";

export interface ContractDrift {
  ok: false;
  command: CliCommandId;
  reason: ContractDriftReason;
  /** The keys the reader needed and did not find, by the name the reader uses. */
  missing: string[];
  /** One sentence naming what was found instead. */
  detail: string;
  /** The CLI's own contract id when it published one, e.g. `kin.status.v3`. */
  schema?: string;
}

/**
 * A soft note: the answer was structurally readable, but the CLI published a
 * contract id this extension has never been tested against. Worth telling the
 * user once; not worth refusing an answer that parsed cleanly.
 */
export interface ContractNote {
  command: CliCommandId;
  reason: "unknown-schema";
  schema: string;
  detail: string;
}

export interface ContractOk<T> {
  ok: true;
  value: T;
  note?: ContractNote;
}

export type ContractResult<T> = ContractOk<T> | ContractDrift;

/**
 * Contract ids this extension has been tested against. `kin status --json`
 * publishes one; the other commands do not, which is why only status carries a
 * schema check.
 */
export const KNOWN_STATUS_SCHEMAS: readonly string[] = ["kin.status.v3"];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeTopLevel(value: unknown): string {
  if (Array.isArray(value)) {
    return `a JSON array of ${value.length} item(s)`;
  }
  if (value === null) {
    return "null";
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return keys.length
      ? `a JSON object carrying ${keys.join(", ")}`
      : "an empty JSON object";
  }
  return `a JSON ${typeof value}`;
}

/**
 * One field the reader dereferences, plus every key the CLI has been seen to
 * publish it under. A field counts as present when any of its keys is present,
 * so a rename on the CLI side that keeps a documented alias does not trip the
 * guard, and a rename that drops every alias does.
 */
interface FieldSpec {
  field: string;
  keys: string[];
}

const ENTITY_FIELDS: FieldSpec[] = [
  { field: "kind", keys: ["kind", "entity_kind"] },
  { field: "name", keys: ["name", "entity_name"] },
  { field: "file", keys: ["file", "file_path", "read_path"] },
  { field: "line", keys: ["line", "start_line"] },
];

const REVIEW_FINDING_FIELDS: FieldSpec[] = [
  { field: "entity", keys: ["entity", "name"] },
  { field: "kind", keys: ["kind"] },
  { field: "line", keys: ["line", "start_line"] },
  { field: "severity", keys: ["severity"] },
  { field: "message", keys: ["message", "title"] },
];

function missingFields(record: UnknownRecord, fields: FieldSpec[]): string[] {
  return fields
    .filter((spec) => !spec.keys.some((key) => key in record))
    .map((spec) => spec.field);
}

function missingKeys(record: UnknownRecord, required: string[]): string[] {
  return required.filter((key) => !(key in record));
}

// ---------------------------------------------------------------------------
// Readers, one per command
// ---------------------------------------------------------------------------

/**
 * `kin status --json`.
 *
 * Measured on kin 0.6.0: a JSON object carrying `authority`,
 * `authority_payload`, `embedding_coverage`, `repo_root`, `repository`,
 * `schema`, `semantic_enrichment` and `workspace`. The entity count and the
 * graph's own state live under `semantic_enrichment`, not at the top level.
 */
export function readStatus(parsed: unknown): ContractResult<KinStatus> {
  if (!isRecord(parsed)) {
    return {
      ok: false,
      command: "status",
      reason: "wrong-top-level-type",
      missing: ["schema", "repository", "semantic_enrichment"],
      detail: `kin status --json answered with ${describeTopLevel(parsed)}, not a JSON object.`,
    };
  }

  const schema = typeof parsed.schema === "string" ? parsed.schema : undefined;
  const absent = missingKeys(parsed, ["schema", "repository", "semantic_enrichment"]);
  if (absent.length > 0) {
    return {
      ok: false,
      command: "status",
      reason: "missing-top-level-keys",
      missing: absent,
      detail: `kin status --json answered with ${describeTopLevel(parsed)}.`,
      schema,
    };
  }

  const enrichment = parsed.semantic_enrichment;
  if (!isRecord(enrichment)) {
    return {
      ok: false,
      command: "status",
      reason: "missing-nested-keys",
      missing: ["semantic_enrichment.entity_count", "semantic_enrichment.presence"],
      detail: `kin status --json carried semantic_enrichment as ${describeTopLevel(enrichment)}, not a JSON object.`,
      schema,
    };
  }

  const absentNested = missingKeys(enrichment, ["entity_count", "presence"]);
  if (absentNested.length > 0) {
    return {
      ok: false,
      command: "status",
      reason: "missing-nested-keys",
      missing: absentNested.map((key) => `semantic_enrichment.${key}`),
      detail: `kin status --json carried semantic_enrichment with ${Object.keys(enrichment).sort().join(", ")}.`,
      schema,
    };
  }

  const value: KinStatus = {
    initialized: true,
    entityCount: Number(enrichment.entity_count ?? 0),
    graphState: describeGraphState(enrichment),
    reachable: true,
  };

  if (schema && !KNOWN_STATUS_SCHEMAS.includes(schema)) {
    return {
      ok: true,
      value,
      note: {
        command: "status",
        reason: "unknown-schema",
        schema,
        detail: `kin status --json published contract ${schema}, which this extension has not been tested against. The status shown was read on a best-effort basis.`,
      },
    };
  }

  return { ok: true, value };
}

/**
 * Say what the CLI says. `presence` is the graph's own word for whether
 * enrichment landed, and `completion_attested` is its own word for whether that
 * landing was proven. Collapsing both into "healthy" would invent a claim the
 * CLI declined to make.
 */
function describeGraphState(enrichment: UnknownRecord): string {
  const presence = String(enrichment.presence ?? "unknown");
  if (presence !== "present") {
    return presence;
  }
  return enrichment.completion_attested === true
    ? "present, completion attested"
    : "present, completion not attested";
}

/**
 * `kin overview --json`.
 *
 * Measured on kin 0.6.0: a JSON object carrying `edges`, `entities`, `files`
 * and `kinds`.
 */
export function readOverview(parsed: unknown): ContractResult<KinOverview> {
  if (!isRecord(parsed)) {
    return {
      ok: false,
      command: "overview",
      reason: "wrong-top-level-type",
      missing: ["entities", "edges", "files", "kinds"],
      detail: `kin overview --json answered with ${describeTopLevel(parsed)}, not a JSON object.`,
    };
  }

  const absent = missingKeys(parsed, ["entities", "edges", "files", "kinds"]);
  if (absent.length > 0) {
    return {
      ok: false,
      command: "overview",
      reason: "missing-top-level-keys",
      missing: absent,
      detail: `kin overview --json answered with ${describeTopLevel(parsed)}.`,
    };
  }

  const entities = Number(parsed.entities ?? 0);
  const availability: GraphAvailability = entities > 0 ? "indexed" : "empty";
  return {
    ok: true,
    value: {
      entities,
      edges: Number(parsed.edges ?? 0),
      files: Number(parsed.files ?? 0),
      kinds: isRecord(parsed.kinds) ? (parsed.kinds as Record<string, number>) : {},
      indexed: entities > 0,
      availability,
      compatFallback: false,
    },
  };
}

/**
 * `kin search <query> --json` and `kin trace <entity> --json`.
 *
 * Measured on kin 0.6.0: both answer with a JSON array. Search elements carry
 * `end_line`, `file`, `id`, `kind`, `line`, `match_kind`, `name`, `signature`
 * and an optional `score`; trace elements carry `file`, `kind`, `line`, `name`,
 * `signature`.
 *
 * An empty array is a legitimate empty answer, not drift. A result set with no
 * elements publishes no element keys, so checking element shape against it
 * would report drift on every query that simply found nothing.
 */
export function readEntities(
  command: "search" | "trace",
  parsed: unknown
): ContractResult<KinEntity[]> {
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      command,
      reason: "wrong-top-level-type",
      missing: ENTITY_FIELDS.map((spec) => spec.field),
      detail: `kin ${command} --json answered with ${describeTopLevel(parsed)}, not a JSON array.`,
    };
  }

  if (parsed.length === 0) {
    return { ok: true, value: [] };
  }

  const first = parsed[0];
  if (!isRecord(first)) {
    return {
      ok: false,
      command,
      reason: "missing-element-keys",
      missing: ENTITY_FIELDS.map((spec) => spec.field),
      detail: `kin ${command} --json answered with an array whose first element is ${describeTopLevel(first)}, not a JSON object.`,
    };
  }

  const absent = missingFields(first, ENTITY_FIELDS);
  if (absent.length > 0) {
    return {
      ok: false,
      command,
      reason: "missing-element-keys",
      missing: absent,
      detail: `kin ${command} --json answered with entries carrying ${Object.keys(first).sort().join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: parsed.map((raw) => normalizeEntity(isRecord(raw) ? raw : {})),
  };
}

export function normalizeEntity(raw: UnknownRecord): KinEntity {
  const provenance = isRecord(raw.provenance) ? raw.provenance : {};
  const span = Array.isArray(raw.span) ? raw.span : [];

  return {
    kind: String(raw.kind ?? raw.entity_kind ?? "Unknown"),
    name: String(raw.name ?? raw.entity_name ?? ""),
    file: String(
      raw.file ?? raw.file_path ?? raw.read_path ?? provenance.file ?? ""
    ),
    line: Number(raw.line ?? raw.start_line ?? span[0] ?? 1),
    signature: raw.signature ? String(raw.signature) : undefined,
  };
}

/**
 * `kin review --files <path> --json`.
 *
 * Measured on kin 0.6.0: a JSON object carrying `file`, `findings` and
 * `summary`, where each finding carries `entity`, `file`, `kind`, `line`,
 * `message` and `severity`.
 */
export function readReview(
  parsed: unknown,
  fallbackFile: string
): ContractResult<KinReviewResult> {
  if (!isRecord(parsed)) {
    return {
      ok: false,
      command: "review",
      reason: "wrong-top-level-type",
      missing: ["file", "findings", "summary"],
      detail: `kin review --json answered with ${describeTopLevel(parsed)}, not a JSON object.`,
    };
  }

  const absent = missingKeys(parsed, ["file", "findings", "summary"]);
  if (absent.length > 0) {
    return {
      ok: false,
      command: "review",
      reason: "missing-top-level-keys",
      missing: absent,
      detail: `kin review --json answered with ${describeTopLevel(parsed)}.`,
    };
  }

  if (!Array.isArray(parsed.findings)) {
    return {
      ok: false,
      command: "review",
      reason: "missing-top-level-keys",
      missing: ["findings"],
      detail: `kin review --json carried findings as ${describeTopLevel(parsed.findings)}, not a JSON array.`,
    };
  }

  if (parsed.findings.length > 0) {
    const first = parsed.findings[0];
    if (!isRecord(first)) {
      return {
        ok: false,
        command: "review",
        reason: "missing-element-keys",
        missing: REVIEW_FINDING_FIELDS.map((spec) => spec.field),
        detail: `kin review --json answered with a findings array whose first element is ${describeTopLevel(first)}, not a JSON object.`,
      };
    }
    const absentFields = missingFields(first, REVIEW_FINDING_FIELDS);
    if (absentFields.length > 0) {
      return {
        ok: false,
        command: "review",
        reason: "missing-element-keys",
        missing: absentFields,
        detail: `kin review --json answered with findings carrying ${Object.keys(first).sort().join(", ")}.`,
      };
    }
  }

  return {
    ok: true,
    value: {
      file: String(parsed.file ?? fallbackFile),
      findings: parsed.findings.map((raw) =>
        normalizeReviewFinding(isRecord(raw) ? raw : {}, fallbackFile)
      ),
      summary: String(parsed.summary ?? ""),
    },
  };
}

export function normalizeReviewFinding(
  raw: UnknownRecord,
  fallbackFile: string
): KinReviewFinding {
  const severity = raw.severity;
  return {
    entity: String(raw.entity ?? raw.name ?? ""),
    kind: String(raw.kind ?? "Review"),
    file: String(raw.file ?? fallbackFile),
    line: Number(raw.line ?? raw.start_line ?? 1),
    severity:
      severity === "error" || severity === "warning" || severity === "info"
        ? severity
        : "info",
    message: String(raw.message ?? raw.title ?? ""),
  };
}

// ---------------------------------------------------------------------------
// User-facing text
// ---------------------------------------------------------------------------

/**
 * The one message a user sees when the CLI contract has drifted. It names the
 * command, names the keys the reader could not find, and names both remedies,
 * because from inside the editor there is no way to tell which side moved.
 */
export function describeDrift(drift: ContractDrift): string {
  const schemaNote = drift.schema ? ` (CLI contract ${drift.schema})` : "";
  return (
    `Kin: the CLI answered \`kin ${drift.command} --json\` in a shape this extension ` +
    `cannot read${schemaNote}. Missing: ${drift.missing.join(", ")}. ${drift.detail} ` +
    `Update the Kin VS Code extension, or update the kin CLI, so the two agree.`
  );
}

export function describeNote(note: ContractNote): string {
  return `Kin: ${note.detail} Update the Kin VS Code extension if anything looks wrong.`;
}

/** Dedup key, so one drift is reported once per session rather than per call. */
export function driftKey(drift: ContractDrift): string {
  return `${drift.command}:${drift.reason}:${drift.missing.join(",")}`;
}

export function noteKey(note: ContractNote): string {
  return `${note.command}:${note.reason}:${note.schema}`;
}
