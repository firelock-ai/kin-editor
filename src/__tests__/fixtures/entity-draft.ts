// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0
import type { EntityDraft, EntitySourceBase, DraftApplied } from "../../entity-draft-contract";
import persistedAppliedRecord from "./entity-draft-applied-record.json";

export const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
export const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
export const SESSION_ID = "33333333-3333-4333-8333-333333333333";
export const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
export const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
export const HASH = "a".repeat(64);
export const originalBody = "function f() { return 'é'; }";
export function sourceBase(): EntitySourceBase {
  return { schema: "kin.entity.source_base.v1", context: {
    repository_id: "fixture-repository", workspace_id: WORKSPACE_ID,
    workspace_generation: 4, workspace_head_hash: HASH, workspace_tree_hash: HASH,
  }, entity_id: ENTITY_ID, artifact_id: ARTIFACT_ID, source_blob_hash: HASH,
  start_byte: 10, end_byte: 10 + Buffer.byteLength(originalBody), body_hash: HASH };
}
export function draft(overrides: Partial<EntityDraft> = {}): EntityDraft {
  return { schema: "kin.entity.draft.v1", draft_id: DRAFT_ID, revision: 1, content_revision: 1,
    scope: { repository_id: "fixture-repository", workspace_id: WORKSPACE_ID, entity_id: ENTITY_ID, owner: "local-bearer-v1" },
    original_body: originalBody, original_source_base: sourceBase(), body: "", previous_record_hash: null,
    request_hash: HASH, pending_apply: null, applied_receipt: null, ...overrides };
}
export function applied(): DraftApplied {
  const requestId = `draft:${DRAFT_ID}:1:request`;
  const roots = (generation: number) => ({ version: 1, generation,
    ...Object.fromEntries(["history", "ref_state", "ref_log", "collaboration", "replication", "local_state"].map(key => [key, { version: 1, hash: Array.from(Buffer.from(HASH, "hex")) }])) });
  const receipt = { schema: "kin.mutate.receipt.v1", status: "committed", state: "committed",
    request_id: requestId, transaction_id: SESSION_ID, change_id: HASH,
    ops_applied: 1, modified_files: ["src/example.ts"], entity_deltas: 1, relation_deltas: 0,
    repository_id: "fixture-repository", repository_operation_id: SESSION_ID,
    repository_generation: 5, repository_transaction_hash: HASH,
    roots_before: roots(4), roots_after: roots(5) };
  return { schema: "kin.entity.draft.applied.v1", draft_id: DRAFT_ID, requested_revision: 1,
    applied_draft_revision: 1, current_text_applied: true, receipt_saved: true, receipt,
    draft: draft({ revision: 3, previous_record_hash: HASH,
      applied_receipt: { attempt: { requested_revision: 1, draft_revision: 1,
        session_id: SESSION_ID, request_id: requestId,
        arguments: { session_id: SESSION_ID, request_id: requestId } }, receipt } }) };
}
export const capabilities = { schema: "kin.entity.draft.capabilities.v1",
  durable_save_supported: true, apply_supported: true,
  limits: { body_bytes: 8388608, total_bytes: 536870912, drafts: 4096, revisions: 65536 }, refusal: null };
// Source-derived Windows capability response: Save is supported on admitted
// NTFS storage while repository publication still has an explicit refusal.
export const windowsSaveCapabilities = { ...capabilities, apply_supported: false,
  refusal: { code: "draft_apply_durability_unsupported",
    message: "Durable repository publication is not yet supported on Windows. Save remains available on supported storage. No Apply attempt was created." } };
// Universal metadata shape from the real draft MCP process proof. It describes
// the runtime; draft persistence and source expectations remain domain fields.
export const runtimeEnvelope = {
  degraded: { embed_persistence_unavailable: false, embed_worker_failed: false, mass_deletion_blocked: false },
  durability: { durable_entities: 2, durable_relations: 1, live_entities: 2, live_only_entities: 0, live_only_relations: 0, live_relations: 1, state: "recorded" },
  envelope_version: 2, freshness: { state: "no_admission_recorded" }, graph_as_of: { generation: 1 },
  graph_state: { entity_count: 2, initialized: true, loaded: true, reconciliation_status: "idle" },
  hydration_semantics: { created_under: 11, derives: 11, standing: "current" }, runtime: "repo-daemon",
};
export function pendingError(message: string): string {
  return JSON.stringify({ schema: "kin.entity.draft.apply_pending.v1", code: "draft_apply_unresolved",
    draft_id: DRAFT_ID, receipt_saved: false,
    mutation_result: { isError: true, content: [{ type: "text", text: message }] } });
}

// Actual daemon-persisted record from a successful guarded draft publication.
// The Apply wrapper follows entity_drafts_apply's response; the record/receipt
// bytes are retained unchanged, including AuthorityRoot's serde byte arrays.
export function actualAppliedRecord(): DraftApplied {
  const draft = structuredClone(persistedAppliedRecord.draft) as EntityDraft;
  const applied = draft.applied_receipt!;
  return { schema: "kin.entity.draft.applied.v1", draft_id: draft.draft_id,
    requested_revision: applied.attempt.requested_revision,
    applied_draft_revision: applied.attempt.draft_revision,
    current_text_applied: draft.content_revision === applied.attempt.draft_revision,
    receipt_saved: true, receipt: applied.receipt, draft };
}
