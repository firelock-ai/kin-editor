// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

/** Closed optimistic source expectation. It is not an authorization token. */
export interface EntitySourceBase {
  schema: "kin.entity.source_base.v1";
  context: {
    repository_id: string; workspace_id: string; workspace_generation: number;
    workspace_head_hash: string; workspace_tree_hash: string;
  };
  entity_id: string; artifact_id: string; source_blob_hash: string;
  start_byte: number; end_byte: number; body_hash: string;
}
export interface DraftScope {
  repository_id: string; workspace_id: string; entity_id: string; owner: "local-bearer-v1";
}
export interface DraftAttempt {
  requested_revision: number; draft_revision: number; session_id: string;
  request_id: string; arguments: Record<string, unknown>;
}
export interface EntityDraft {
  schema: "kin.entity.draft.v1"; draft_id: string; revision: number; content_revision: number;
  scope: DraftScope; original_body: string; original_source_base: EntitySourceBase;
  body: string; previous_record_hash: string | null; request_hash: string;
  pending_apply: DraftAttempt | null;
  applied_receipt: { attempt: DraftAttempt; receipt: Record<string, unknown> } | null;
}
export interface DraftCreate {
  draft_id: string; original_source_base: EntitySourceBase; original_body: string; body: string;
}
export interface DraftSave { draft_id: string; expected_revision: number; body: string }
export interface DraftApply { draft_id: string; expected_revision: number; session_id: string }
export interface DraftCapabilities {
  schema: "kin.entity.draft.capabilities.v1"; durable_save_supported: boolean; apply_supported: boolean;
  limits: { body_bytes: number; total_bytes: number; drafts: number; revisions: number };
  refusal: { code: string; message: string } | null;
}
export interface DraftApplied {
  schema: "kin.entity.draft.applied.v1"; draft_id: string; requested_revision: number;
  applied_draft_revision: number; current_text_applied: boolean; receipt_saved: true;
  receipt: Record<string, unknown>; draft: EntityDraft;
  publication_accounting?: Record<string, unknown> | null;
}
export interface DraftList { entity_id?: string; after?: string; limit?: number }
export interface DraftSummary {
  draft_id: string; revision: number; content_revision: number; scope: DraftScope;
  body_bytes: number; has_pending_apply: boolean; has_applied_receipt: boolean;
}
export interface DraftListing {
  schema: "kin.entity.drafts.v1"; drafts: DraftSummary[];
  next_cursor: string | null; recovery_evidence: string[];
}

export class DraftContractError extends Error {
  constructor(detail: string) {
    super(`The Kin draft protocol could not be verified: ${detail}`);
    this.name = "DraftContractError";
  }
}

export function draftAssert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new DraftContractError(detail);
}
function object(value: unknown, label: string): Record<string, unknown> {
  draftAssert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
function closed(value: unknown, fields: string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  draftAssert(Object.keys(result).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(result, key)), `${label} fields do not match its version`);
  return result;
}
function text(value: unknown, label: string, empty = false): asserts value is string {
  draftAssert(typeof value === "string" && (empty || value.length > 0), `${label} must be a string`);
}
export function draftUuid(value: unknown, label: string): asserts value is string {
  draftAssert(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), `${label} must be a UUID`);
}
function hash(value: unknown, label: string): void {
  draftAssert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${label} must be a lowercase 256-bit hash`);
}
function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  draftAssert(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, `${label} must be a safe integer >= ${minimum}`);
}
function boolean(value: unknown, label: string): asserts value is boolean {
  draftAssert(typeof value === "boolean", `${label} must be a boolean`);
}
function repository(value: unknown): void {
  text(value, "repository_id");
  draftAssert(Buffer.byteLength(value) <= 255 && !Array.from(value).some(char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  }), "repository_id is invalid");
}
export function draftJson(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new DraftContractError("response is not JSON"); }
}

type ObservationType = "string" | "integer" | "boolean" | "object" | "strings" |
  "string?" | "integer?" | "boolean?";
function observation(value: unknown, label: string, required: string[], fields: Record<string, ObservationType>): void {
  const block = object(value, label);
  for (const key of required) draftAssert(Object.hasOwn(block, key), `${label}.${key} is missing`);
  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.hasOwn(block, key)) continue;
    const item = block[key];
    if (kind.endsWith("?") && item === null) continue;
    const name = `${label}.${key}`;
    switch (kind.replace("?", "")) {
      case "string": text(item, name, true); break;
      case "integer": integer(item, name); break;
      case "boolean": boolean(item, name); break;
      case "object": object(item, name); break;
      case "strings":
        draftAssert(Array.isArray(item), `${name} must be an array`);
        for (const entry of item) text(entry, name, true);
    }
  }
}

/** The universal envelope is additive metadata, never an editing expectation. */
export function splitDraftMcpPayload(value: unknown): { payload: unknown; envelope?: Record<string, unknown> } {
  const result = object(value, "MCP response");
  if (!Object.hasOwn(result, "_kin")) return { payload: value };
  const envelope = object(result._kin, "_kin");
  draftAssert(envelope.envelope_version === 2, "unsupported MCP envelope version");
  draftAssert(envelope.runtime === "repo-daemon" || envelope.runtime === "offline-in-process", "unknown MCP runtime");
  observation(envelope.degraded, "_kin.degraded", [], {
    daemon_unreachable: "boolean?", embed_worker_failed: "boolean?", embed_persistence_unavailable: "boolean?",
    mass_deletion_blocked: "boolean?", offline_fallback: "boolean?", workspace_mismatch: "boolean?",
    daemon_killed_by_memory: "boolean?", sweep_suspended: "boolean?", memory_pressure: "boolean?",
    memory_pressure_work: "string?", relation_census_loss: "boolean?", hydration_semantics_stale: "boolean?",
    enrichment_shortfall: "boolean?", no_repository: "boolean?",
  });
  if (Object.hasOwn(envelope, "graph_state")) observation(envelope.graph_state, "_kin.graph_state", [], {
    reconciliation_status: "string?", entity_count: "integer?", entity_count_scope: "string?", loaded: "boolean?", initialized: "boolean?",
  });
  const blocks: Record<string, [string[], Record<string, ObservationType>]> = {
    durability: [["state"], { state: "string", live_entities: "integer?", durable_entities: "integer?", live_only_entities: "integer?", live_relations: "integer?", durable_relations: "integer?", live_only_relations: "integer?" }],
    hydration_semantics: [["standing", "derives"], { standing: "string", derives: "integer", created_under: "integer?", reason: "string?" }],
    semantic_coverage: [["indexed", "total", "pending", "complete"], { indexed: "integer", total: "integer", pending: "integer", complete: "boolean", embedding_state_reported: "string?", limited_by: "strings", read_at: "string?", graph_body_gap_paths: "integer?" }],
    behind: [["unadmitted_paths", "measured"], { unadmitted_paths: "integer", measured: "boolean", since: "string?", sample: "strings", measured_age_seconds: "integer?" }],
    freshness: [["state"], { state: "string", at: "string", age_seconds: "integer?", basis: "string", reason: "string", settled_age_ms: "integer", observed_authority_epoch: "integer?", live_attempts: "integer" }],
    watcher_loss: [["generation", "recovered_through"], { generation: "integer", recovered_through: "integer", at: "string?", reason: "string?", read_error: "string?" }],
    completeness: [["status", "bound", "substrate", "classes", "decided_by"], { status: "string", bound: "string", substrate: "string", classes: "object", decided_by: "strings", limits: "strings" }],
    response: [["max_chars", "chars_before_budget", "chars_after_budget", "bounded", "compact"], { max_chars: "integer", chars_before_budget: "integer", chars_after_budget: "integer", bounded: "boolean", compact: "boolean", primary_collection: "string?", primary_rows: "integer?" }],
    answered_by: [["pid", "repo_root", "repo_id", "uptime_seconds"], { pid: "integer", repo_root: "string", repo_id: "string", uptime_seconds: "integer", version: "string?" }],
  };
  for (const [key, [required, fields]] of Object.entries(blocks)) {
    if (Object.hasOwn(envelope, key) && envelope[key] !== null) observation(envelope[key], `_kin.${key}`, required, fields);
  }
  // Only this reserved top-level key is separated. Unknown domain fields still
  // reach the closed parser. Opaque additive metadata is retained in envelope.
  const payload = { ...result };
  delete payload._kin;
  return { payload, envelope };
}

export function parseSourceBase(value: unknown): EntitySourceBase {
  const base = closed(value, ["schema", "context", "entity_id", "artifact_id", "source_blob_hash", "start_byte", "end_byte", "body_hash"], "source_base");
  draftAssert(base.schema === "kin.entity.source_base.v1", "unknown source_base schema");
  const context = closed(base.context, ["repository_id", "workspace_id", "workspace_generation", "workspace_head_hash", "workspace_tree_hash"], "source_base.context");
  repository(context.repository_id);
  draftUuid(context.workspace_id, "workspace_id");
  integer(context.workspace_generation, "workspace_generation");
  hash(context.workspace_head_hash, "workspace_head_hash");
  hash(context.workspace_tree_hash, "workspace_tree_hash");
  draftUuid(base.entity_id, "entity_id");
  draftUuid(base.artifact_id, "artifact_id");
  for (const key of ["source_blob_hash", "body_hash"]) hash(base[key], key);
  integer(base.start_byte, "start_byte"); integer(base.end_byte, "end_byte", 1);
  draftAssert(base.end_byte > base.start_byte, "source_base must name a nonempty byte span");
  return value as EntitySourceBase;
}
function scope(value: unknown): DraftScope {
  const result = closed(value, ["repository_id", "workspace_id", "entity_id", "owner"], "draft scope");
  repository(result.repository_id);
  draftUuid(result.workspace_id, "workspace_id"); draftUuid(result.entity_id, "entity_id");
  draftAssert(result.owner === "local-bearer-v1", "unknown draft owner");
  return value as DraftScope;
}
function attempt(value: unknown): DraftAttempt {
  const result = closed(value, ["requested_revision", "draft_revision", "session_id", "request_id", "arguments"], "draft attempt");
  integer(result.requested_revision, "requested_revision", 1); integer(result.draft_revision, "draft_revision", 1);
  draftAssert(result.draft_revision <= result.requested_revision, "attempt content revision exceeds requested revision");
  draftUuid(result.session_id, "session_id"); text(result.request_id, "request_id");
  const args = object(result.arguments, "attempt arguments");
  draftAssert(args.session_id === result.session_id && args.request_id === result.request_id, "attempt arguments disagree with its identity");
  return value as DraftAttempt;
}
function receipt(value: unknown, repositoryId: string, requestId?: string): Record<string, unknown> {
  const result = object(value, "mutation receipt");
  draftAssert(result.schema === "kin.mutate.receipt.v1" && result.status === "committed" && result.state === "committed", "mutation receipt is not committed");
  draftAssert(result.repository_id === repositoryId, "mutation receipt names another repository");
  text(result.request_id, "receipt request_id");
  if (requestId !== undefined) draftAssert(result.request_id === requestId, "mutation receipt names another request");
  draftUuid(result.transaction_id, "transaction_id"); draftUuid(result.repository_operation_id, "repository_operation_id");
  draftAssert(result.transaction_id === result.repository_operation_id, "receipt operation identity differs");
  hash(result.change_id, "change_id"); hash(result.repository_transaction_hash, "repository_transaction_hash");
  for (const key of ["ops_applied", "entity_deltas", "relation_deltas", "repository_generation"]) integer(result[key], key);
  draftAssert(Array.isArray(result.modified_files), "modified_files must be an array");
  for (const id of result.modified_files) text(id, "modified file");
  const before = roots(result.roots_before); const after = roots(result.roots_after);
  draftAssert(after.generation === result.repository_generation && before.generation < after.generation,
    "receipt roots disagree with the committed generation");
  return result;
}
function roots(value: unknown): { generation: number } {
  const partitions = ["history", "ref_state", "ref_log", "collaboration", "replication", "local_state"];
  const result = closed(value, ["version", "generation", ...partitions], "receipt roots");
  draftAssert(result.version === 1, "unsupported receipt root version");
  integer(result.generation, "root generation");
  for (const key of partitions) {
    const root = closed(result[key], ["version", "hash"], key);
    draftAssert(root.version === 1, "unsupported authority root version");
    // AuthorityRoot retains kin_blobs::Hash256's serde [u8; 32] representation.
    // Explicit source and transaction hash strings use their own hex contract.
    draftAssert(Array.isArray(root.hash) && root.hash.length === 32, `${key} hash must contain exactly 32 bytes`);
    for (const byte of root.hash) {
      draftAssert(typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
        `${key} hash must contain only uint8 bytes`);
    }
  }
  return { generation: result.generation };
}
export function parseEntityDraft(value: unknown): EntityDraft {
  const result = closed(value, ["schema", "draft_id", "revision", "content_revision", "scope", "original_body", "original_source_base", "body", "previous_record_hash", "request_hash", "pending_apply", "applied_receipt"], "draft");
  draftAssert(result.schema === "kin.entity.draft.v1", "unknown draft schema");
  draftUuid(result.draft_id, "draft_id"); integer(result.revision, "revision", 1); integer(result.content_revision, "content_revision", 1);
  draftAssert(result.content_revision <= result.revision, "content revision exceeds draft revision");
  const owner = scope(result.scope); const base = parseSourceBase(result.original_source_base);
  draftAssert(owner.repository_id === base.context.repository_id && owner.workspace_id === base.context.workspace_id && owner.entity_id === base.entity_id, "draft scope differs from original source");
  text(result.original_body, "original_body", true); text(result.body, "body", true);
  draftAssert(Buffer.byteLength(result.original_body) === base.end_byte - base.start_byte, "original body length differs from source_base span");
  draftAssert((result.previous_record_hash === null) === (result.revision === 1), "draft predecessor does not match revision");
  if (result.previous_record_hash !== null) hash(result.previous_record_hash, "previous_record_hash");
  hash(result.request_hash, "request_hash");
  if (result.pending_apply !== null) {
    const pending = attempt(result.pending_apply);
    draftAssert(pending.requested_revision < result.revision, "pending attempt was not persisted after its requested revision");
  }
  if (result.applied_receipt !== null) {
    const applied = closed(result.applied_receipt, ["attempt", "receipt"], "applied_receipt");
    const original = attempt(applied.attempt);
    draftAssert(original.requested_revision < result.revision, "receipt predates its attempt");
    receipt(applied.receipt, owner.repository_id, original.request_id);
  }
  return value as EntityDraft;
}
export function validateDraftCreate(value: DraftCreate): void {
  closed(value, ["draft_id", "original_source_base", "original_body", "body"], "draft create");
  draftUuid(value.draft_id, "draft_id"); const base = parseSourceBase(value.original_source_base);
  text(value.original_body, "original_body", true); text(value.body, "body", true);
  draftAssert(Buffer.byteLength(value.original_body) === base.end_byte - base.start_byte, "original body length differs from source_base");
}
export function validateDraftSave(value: DraftSave): void {
  closed(value, ["draft_id", "expected_revision", "body"], "draft save");
  draftUuid(value.draft_id, "draft_id"); integer(value.expected_revision, "expected_revision", 1);
  draftAssert(value.expected_revision < Number.MAX_SAFE_INTEGER, "next revision cannot be represented exactly");
  text(value.body, "body", true);
}
export function validateDraftApply(value: DraftApply): void {
  closed(value, ["draft_id", "expected_revision", "session_id"], "draft apply");
  draftUuid(value.draft_id, "draft_id"); draftUuid(value.session_id, "session_id"); integer(value.expected_revision, "expected_revision", 1);
}
export function validateDraftRead(id: string, revision?: number): void {
  draftUuid(id, "draft_id"); if (revision !== undefined) integer(revision, "revision", 1);
}
export function validateDraftList(value: DraftList): void {
  const args = object(value, "draft list");
  draftAssert(Object.keys(args).every(key => ["entity_id", "after", "limit"].includes(key)), "unknown draft list field");
  if (value.entity_id !== undefined) draftUuid(value.entity_id, "entity_id");
  if (value.after !== undefined) draftUuid(value.after, "after");
  if (value.limit !== undefined) { integer(value.limit, "limit", 1); draftAssert(value.limit <= 200, "limit exceeds 200"); }
}
export function parseDraftSaved(value: unknown): EntityDraft {
  const result = closed(value, ["schema", "draft", "already_saved"], "saved response");
  draftAssert(result.schema === "kin.entity.draft.saved.v1", "unknown saved schema");
  boolean(result.already_saved, "already_saved");
  return parseEntityDraft(result.draft);
}
export function parseDraftCapabilities(value: unknown): DraftCapabilities {
  const result = closed(value, ["schema", "durable_save_supported", "apply_supported", "limits", "refusal"], "draft capabilities");
  draftAssert(result.schema === "kin.entity.draft.capabilities.v1", "unknown capabilities schema");
  boolean(result.durable_save_supported, "durable_save_supported"); boolean(result.apply_supported, "apply_supported");
  const limits = closed(result.limits, ["body_bytes", "total_bytes", "drafts", "revisions"], "draft limits");
  for (const [key, limit] of Object.entries(limits)) integer(limit, key, 1);
  if (result.refusal !== null) {
    const refusal = closed(result.refusal, ["code", "message"], "capability refusal");
    text(refusal.code, "refusal code"); text(refusal.message, "refusal message");
  }
  draftAssert(!result.apply_supported || result.durable_save_supported, "Apply cannot be supported without durable Save");
  draftAssert((result.refusal === null) === (result.durable_save_supported && result.apply_supported), "capabilities contradict refusal");
  return value as DraftCapabilities;
}
/** Reconstructible reporting is separate from the immutable v1 receipt. */
function publicationAccounting(value: unknown): void {
  // Older retained publications can have no accounting. This never substitutes
  // for a committed receipt or changes which saved draft revision was applied.
  if (value === null) return;
  const block = object(value, "publication_accounting");
  draftAssert(block.schema === "kin.publication_accounting.v1", "unknown publication accounting schema");
  draftAssert(block.status === "exact" || block.status === "unavailable", "unknown publication accounting status");
  text(block.meaning, "publication accounting meaning");
  integer(block.identity_sample_limit, "identity_sample_limit");
  if (block.status === "unavailable") text(block.reason, "publication accounting reason");
  else for (const name of ["entities", "relationships", "source_units"]) {
    const counts = object(block[name], `publication_accounting.${name}`);
    integer(counts.published_total, `${name}.published_total`);
    for (const category of ["publication_only", "carried_unchanged", "pending_and_publication", "workspace_only"]) {
      const count = object(counts[category], `${name}.${category}`);
      integer(count.count, `${name}.${category}.count`);
      if (Object.hasOwn(count, "sample_ids")) {
        draftAssert(Array.isArray(count.sample_ids) && count.sample_ids.length <= block.identity_sample_limit &&
          count.sample_ids.length <= count.count, "publication identity sample exceeds its bound");
        for (const id of count.sample_ids) draftUuid(id, "publication sample id");
      }
    }
  }
  const requested = object(block.requested, "publication accounting requested");
  draftAssert(requested.status === "verified_request" || requested.status === "unavailable", "unknown requested accounting status");
  if (requested.status === "unavailable") text(requested.reason, "requested accounting reason");
  else {
    integer(requested.operation_count, "requested operation_count");
    integer(requested.omitted_operations, "requested omitted_operations");
    draftAssert(Array.isArray(requested.sample_operations) && requested.sample_operations.length <= block.identity_sample_limit &&
      requested.sample_operations.length + requested.omitted_operations === requested.operation_count,
    "requested operation sample disagrees with its counts");
    for (const entry of requested.sample_operations) {
      const operation = object(entry, "requested operation");
      text(operation.verb, "requested verb");
      object(operation.target, "requested target");
    }
  }
}
export function parseDraftApplied(value: unknown): DraftApplied {
  const fields = ["schema", "draft_id", "requested_revision", "applied_draft_revision", "current_text_applied", "receipt_saved", "receipt", "draft"];
  if (Object.hasOwn(object(value, "applied response"), "publication_accounting")) fields.push("publication_accounting");
  const result = closed(value, fields, "applied response");
  if (Object.hasOwn(result, "publication_accounting")) publicationAccounting(result.publication_accounting);
  draftAssert(result.schema === "kin.entity.draft.applied.v1" && result.receipt_saved === true, "Apply receipt was not acknowledged");
  const draft = parseEntityDraft(result.draft);
  draftAssert(result.draft_id === draft.draft_id, "Apply names another draft");
  integer(result.requested_revision, "requested_revision", 1); integer(result.applied_draft_revision, "applied_draft_revision", 1);
  draftAssert(result.applied_draft_revision <= result.requested_revision && result.requested_revision < draft.revision, "Apply revision order is invalid");
  boolean(result.current_text_applied, "current_text_applied");
  draftAssert(result.current_text_applied === (draft.content_revision === result.applied_draft_revision), "Apply current text flag disagrees with revisions");
  receipt(result.receipt, draft.scope.repository_id);
  return value as DraftApplied;
}
/** Match the immutable attempt, which may belong to an earlier saved revision. */
export function findAppliedDraftAttempt(result: DraftApplied, draft: EntityDraft): DraftAttempt | undefined {
  draftAssert(draft.draft_id === result.draft_id && draft.scope.repository_id === result.draft.scope.repository_id &&
    draft.scope.workspace_id === result.draft.scope.workspace_id && draft.scope.entity_id === result.draft.scope.entity_id,
    "Apply attempt read belongs to another draft scope");
  return [draft.pending_apply, draft.applied_receipt?.attempt].find(candidate =>
    candidate?.requested_revision === result.requested_revision && candidate.draft_revision === result.applied_draft_revision) ?? undefined;
}
export function bindAppliedDraftReceipt(result: DraftApplied, original: DraftAttempt): void {
  draftAssert(original.requested_revision === result.requested_revision && original.draft_revision === result.applied_draft_revision,
    "Apply receipt revision differs from its original attempt");
  receipt(result.receipt, result.draft.scope.repository_id, original.request_id);
}
export function parseDraftListing(value: unknown, request: DraftList): DraftListing {
  const result = closed(value, ["schema", "drafts", "next_cursor", "recovery_evidence"], "draft listing");
  draftAssert(result.schema === "kin.entity.drafts.v1", "unknown listing schema");
  draftAssert(Array.isArray(result.drafts) && result.drafts.length <= (request.limit ?? 50), "draft listing exceeds its page limit");
  let previous = request.after?.toLowerCase();
  let owner: DraftScope | undefined;
  for (const item of result.drafts) {
    const entry = closed(item, ["draft_id", "revision", "content_revision", "scope", "body_bytes", "has_pending_apply", "has_applied_receipt"], "draft summary");
    draftUuid(entry.draft_id, "draft_id"); integer(entry.revision, "revision", 1); integer(entry.content_revision, "content_revision", 1);
    draftAssert(entry.content_revision <= entry.revision, "summary content revision exceeds revision");
    const current = scope(entry.scope);
    if (request.entity_id !== undefined) draftAssert(current.entity_id === request.entity_id, "listing ignored entity filter");
    if (owner) draftAssert(current.repository_id === owner.repository_id && current.workspace_id === owner.workspace_id && current.owner === owner.owner, "listing mixes draft ownership");
    owner = current;
    integer(entry.body_bytes, "body_bytes"); boolean(entry.has_pending_apply, "has_pending_apply"); boolean(entry.has_applied_receipt, "has_applied_receipt");
    draftAssert(previous === undefined || previous < entry.draft_id.toLowerCase(), "listing is not ordered after cursor");
    previous = entry.draft_id.toLowerCase();
  }
  if (result.next_cursor !== null) {
    draftUuid(result.next_cursor, "next_cursor");
    draftAssert(result.drafts.length > 0 && result.next_cursor.toLowerCase() === previous, "next_cursor is not the last returned draft");
  }
  draftAssert(Array.isArray(result.recovery_evidence), "recovery_evidence must be an array");
  for (const item of result.recovery_evidence) text(item, "recovery evidence");
  return value as DraftListing;
}

/** Only actual MCP errors are wrapped here; all evidence remains available. */
export class DraftToolError extends Error {
  readonly payload: unknown;
  readonly code?: string;
  readonly envelope?: Record<string, unknown>;
  constructor(readonly toolName: string, readonly text: string) {
    super(`Kin ${toolName} refused`);
    this.name = "DraftToolError";
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed !== undefined) {
      const separated = splitDraftMcpPayload(parsed);
      this.payload = separated.payload;
      this.envelope = separated.envelope;
    }
    const payload = this.payload as Record<string, unknown> | undefined;
    this.code = typeof payload?.code === "string" ? payload.code : undefined;
    const nested = payload?.mutation_result as { content?: { type?: string; text?: string }[] } | undefined;
    let detail = typeof payload?.message === "string" ? payload.message : this.code ?? text;
    if (Array.isArray(nested?.content)) {
      const refusal = nested.content.find(block => block?.type === "text" && typeof block.text === "string")?.text;
      if (refusal) {
        try {
          const parsed = JSON.parse(refusal) as Record<string, unknown>;
          detail += `: ${String(parsed.reason ?? parsed.message ?? parsed.code ?? "mutation refused")}`;
        } catch { detail += `: ${refusal}`; }
      }
    }
    this.message += `: ${detail.length <= 600 ? detail : `${detail.slice(0, 600)}…`}`;
  }
}
export function isDraftSessionExpired(error: unknown): boolean {
  if (!(error instanceof DraftToolError) || error.toolName !== "kin_draft_apply") return false;
  const payload = error.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const refusal = payload as Record<string, unknown>;
  if (refusal.schema !== "kin.entity.draft.apply_pending.v1" || refusal.code !== "draft_apply_unresolved" || refusal.receipt_saved !== false) return false;
  const nested = refusal.mutation_result as { isError?: unknown; content?: unknown } | undefined;
  if (!nested || nested.isError !== true || !Array.isArray(nested.content) || nested.content.length !== 1) return false;
  const block = nested.content[0];
  if (block?.type !== "text" || typeof block.text !== "string") return false;
  const message = originalMcpMessage(block.text);
  return message !== undefined && message.startsWith("request_session_expired:");
}

function originalMcpMessage(raw: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return raw; }
  try {
    const { payload } = splitDraftMcpPayload(value);
    const wrapper = closed(payload, ["message"], "MCP error text");
    return typeof wrapper.message === "string" ? wrapper.message : undefined;
  } catch { return undefined; }
}

export function isMissingDraftSession(error: unknown, sessionId: string): boolean {
  if (!(error instanceof DraftToolError) || error.toolName !== "kin_session_heartbeat") return false;
  // The daemon delegates this HTTP 404 as text. Bind its exact UUID and error
  // status; arbitrary messages mentioning a missing session are not recovery.
  const message = originalMcpMessage(error.text);
  return message === `Session not found: ${sessionId}` ||
    message?.startsWith(`daemon heartbeat failed: HTTP 404 Not Found: session not found: ${sessionId}.`) === true;
}
export function validateDraftSession(value: unknown, sessionId: string, started: boolean): void {
  const result = object(value, "draft session");
  draftAssert(result.session_id === sessionId && result.status === "active", "daemon did not confirm the exact live session");
  integer(result.idle_timeout_secs, "idle_timeout_secs");
  text(result.idle_reap_eligible_at, "idle_reap_eligible_at");
  text(started ? result.started_at : result.heartbeat_at, "session timestamp");
  if (started) {
    const capabilities = object(result.capabilities, "session capabilities");
    draftAssert(capabilities.can_write === true && capabilities.can_commit === true, "draft session lacks write or commit capability");
  }
}
