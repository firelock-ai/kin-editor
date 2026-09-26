// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0
import {
  DraftContractError, DraftToolError, parseSourceBase, parseEntityDraft, parseDraftSaved,
  parseDraftApplied, parseDraftCapabilities, parseDraftListing, isDraftSessionExpired,
  splitDraftMcpPayload,
} from "../entity-draft-contract";
// Captured from kin 12028d0e: actual successful draft publication domain reply.
// Only universal _kin metadata was separated; receipt and reporting are unchanged.
import actualAccountingApply from "./fixtures/entity-draft-applied-accounting.json";
import { readEntitySource } from "../graph-entity";
import { applied, actualAppliedRecord, capabilities, windowsSaveCapabilities, draft, sourceBase, originalBody, DRAFT_ID, ENTITY_ID, HASH, pendingError, runtimeEnvelope } from "./fixtures/entity-draft";

describe("closed source-base contract", () => {
  test("retains exact context and UTF-8 byte span in graph source", () => {
    const base = sourceBase();
    const document = readEntitySource(JSON.stringify({ id: ENTITY_ID, name: "f", body: originalBody, source_base: base }));
    expect(document.sourceBase).toEqual(base);
    expect(document.body).toBe(originalBody);
    expect(readEntitySource(JSON.stringify({ name: "f", body: "", source_base: null })).sourceBase).toBeUndefined();
  });
  test.each([
    (b: ReturnType<typeof sourceBase>) => ({ ...b, schema: "future" }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, extra: true }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, context: { ...b.context, extra: true } }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, context: { ...b.context, workspace_generation: 1.5 } }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, context: { ...b.context, workspace_generation: Number.MAX_SAFE_INTEGER + 1 } }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, context: { ...b.context, repository_id: "bad\nrepo" } }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, start_byte: b.end_byte }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, artifact_id: "not-an-id" }),
    (b: ReturnType<typeof sourceBase>) => ({ ...b, body_hash: HASH.toUpperCase() }),
  ])("rejects malformed or unrepresentable source expectations %#", change => {
    expect(() => parseSourceBase(change(sourceBase()))).toThrow(DraftContractError);
  });
  test("refuses a source base for another body/entity", () => {
    for (const data of [{ id: DRAFT_ID, body: originalBody }, { id: ENTITY_ID, body: "different" }]) {
      expect(() => readEntitySource(JSON.stringify({ ...data, name: "f", source_base: sourceBase() }))).toThrow(DraftContractError);
    }
  });
  test("unsupported/malformed editing expectations keep the source body readable and readonly", () => {
    for (const base of [{ ...sourceBase(), schema: "future" }, { ...sourceBase(), extra: true }, {}]) {
      const document = readEntitySource(JSON.stringify({ id: ENTITY_ID, name: "f", body: originalBody, source_base: base }));
      expect(document.body).toBe(originalBody);
      expect(document.sourceBase).toBeUndefined();
      expect(document.sourceBaseRefusal).toContain("could not be verified");
    }
  });
});

describe("durable draft responses", () => {
  test("accepts the actual daemon Apply reply with reporting outside its immutable receipt", () => {
    const actual = structuredClone(actualAccountingApply);
    const receiptBytes = JSON.stringify(actual.receipt);
    expect(parseDraftApplied(actual)).toBe(actual);
    expect(actual.current_text_applied).toBe(true);
    expect(JSON.stringify(actual.receipt)).toBe(receiptBytes);
    expect(actual.receipt).not.toHaveProperty("publication_accounting");
    expect(actual.draft.applied_receipt.receipt).toEqual(actual.receipt);
    expect(parseDraftApplied({ ...actual, publication_accounting: null }).receipt).toEqual(actual.receipt);
    const legacy = { ...actual } as Record<string, unknown>;
    delete legacy.publication_accounting;
    expect(parseDraftApplied(legacy).receipt).toEqual(actual.receipt);
  });
  test("accounting cannot replace Apply identity, receipt or current-text truth", () => {
    const actual = structuredClone(actualAccountingApply);
    for (const changed of [
      { ...actual, surprise: true }, { ...actual, receipt_saved: false },
      { ...actual, current_text_applied: false }, { ...actual, draft_id: DRAFT_ID },
      { ...actual, receipt: { ...actual.receipt, status: "pending" } },
      { ...actual, receipt: { ...actual.receipt, repository_id: "other" } },
    ]) expect(() => parseDraftApplied(changed)).toThrow(DraftContractError);
    const later = { ...actual, current_text_applied: false, draft: { ...actual.draft,
      revision: actual.draft.revision + 1, content_revision: actual.draft.revision + 1, body: "newer saved text" } };
    expect(parseDraftApplied(later).current_text_applied).toBe(false);
  });
  test.each([
    undefined, true, {},
    { ...actualAccountingApply.publication_accounting, schema: "future" },
    { ...actualAccountingApply.publication_accounting, status: "pending" },
    { ...actualAccountingApply.publication_accounting, identity_sample_limit: -1 },
    { ...actualAccountingApply.publication_accounting, entities: {} },
    { ...actualAccountingApply.publication_accounting, requested: { status: "verified_request", operation_count: 1, omitted_operations: 0, sample_operations: [] } },
  ])("rejects malformed publication accounting without relaxing the Apply contract %#", reporting => {
    expect(() => parseDraftApplied({ ...actualAccountingApply, publication_accounting: reporting })).toThrow(DraftContractError);
  });
  test("unavailable accounting does not turn a committed publication into an unapplied failure", () => {
    const reporting = { schema: "kin.publication_accounting.v1", status: "unavailable", reason: "historical transition unavailable",
      requested: { status: "unavailable", reason: "historical request unavailable" }, meaning: "reporting only", identity_sample_limit: 3 };
    const result = parseDraftApplied({ ...actualAccountingApply, publication_accounting: reporting });
    expect(result.receipt_saved).toBe(true);
    expect(result.current_text_applied).toBe(true);
  });
  test("accepts actual persisted Apply receipt root byte arrays without rewriting them", () => {
    const actual = actualAppliedRecord();
    expect(parseEntityDraft(actual.draft)).toBe(actual.draft);
    expect(parseDraftApplied(actual)).toBe(actual);
  });
  test.each([[], Array(31).fill(0), Array(33).fill(0), [256, ...Array(31).fill(0)],
    [-1, ...Array(31).fill(0)], [1.5, ...Array(31).fill(0)], ["0", ...Array(31).fill(0)],
    [null, ...Array(31).fill(0)], HASH, { bytes: Array(32).fill(0) }])("refuses malformed authority-root byte hash %#", malformed => {
    const actual = actualAppliedRecord();
    const roots = actual.receipt.roots_after as { history: { hash: unknown } };
    roots.history.hash = malformed;
    expect(() => parseDraftApplied(actual)).toThrow(DraftContractError);
  });
  test("hex source/record/transaction hashes remain hex-only", () => {
    const bytes = Array(32).fill(0);
    expect(() => parseSourceBase({ ...sourceBase(), body_hash: bytes })).toThrow(DraftContractError);
    expect(() => parseEntityDraft({ ...draft(), request_hash: bytes })).toThrow(DraftContractError);
    const actual = actualAppliedRecord();
    actual.receipt.repository_transaction_hash = bytes;
    expect(() => parseDraftApplied(actual)).toThrow(DraftContractError);
  });
  test("empty text and historical draft reads need no live entity or session", () => {
    expect(parseEntityDraft(draft()).body).toBe("");
    expect(parseEntityDraft(draft({ body: "invalid (\n🚀" })).body).toBe("invalid (\n🚀");
    expect(parseDraftSaved({ schema: "kin.entity.draft.saved.v1", already_saved: true, draft: draft() })).toEqual(draft());
  });
  test.each([
    { revision: 0 }, { content_revision: 2 }, { previous_record_hash: HASH },
    { request_hash: "bad" }, { body: null }, { original_body: "" },
    { scope: { ...draft().scope, repository_id: "other" } },
    { original_source_base: { ...sourceBase(), entity_id: DRAFT_ID } },
    { pending_apply: { requested_revision: 1, draft_revision: 1, session_id: DRAFT_ID, request_id: "key", arguments: {} } },
  ])("rejects inconsistent draft evidence %j", change => {
    expect(() => parseEntityDraft({ ...draft(), ...change })).toThrow(DraftContractError);
  });
  test("requires a Saved acknowledgement and explicit booleans", () => {
    expect(() => parseDraftSaved(draft())).toThrow(DraftContractError);
    expect(() => parseDraftSaved({ schema: "kin.entity.draft.saved.v1", already_saved: "true", draft: draft() })).toThrow(DraftContractError);
  });
  test("Apply validates receipt ownership, identity and revision truth", () => {
    const result = applied();
    expect(parseDraftApplied(result)).toEqual(result);
    const newer = { ...result, current_text_applied: false, draft: { ...result.draft, revision: 4, content_revision: 4, body: "later text" } };
    expect(parseDraftApplied(newer).current_text_applied).toBe(false);
    for (const changed of [
      { ...result, receipt_saved: false }, { ...result, current_text_applied: false },
      { ...result, receipt: { ...result.receipt, repository_id: "foreign" } },
      { ...result, receipt: { ...result.receipt, status: "pending" } },
      { ...result, receipt: { ...result.receipt, repository_operation_id: DRAFT_ID } },
      { ...result, receipt: { ...result.receipt, repository_generation: "5" } },
    ]) expect(() => parseDraftApplied(changed)).toThrow(DraftContractError);
  });
  test("capabilities disclose refusal, without manufacturing support", () => {
    expect(parseDraftCapabilities(capabilities).durable_save_supported).toBe(true);
    const unsupported = { ...capabilities, durable_save_supported: false, apply_supported: false,
      refusal: { code: "draft_durability_unsupported", message: "Keep your text" } };
    expect(parseDraftCapabilities(unsupported).refusal?.code).toBe("draft_durability_unsupported");
    expect(() => parseDraftCapabilities({ ...capabilities, durable_save_supported: "true" })).toThrow();
    expect(() => parseDraftCapabilities({ ...unsupported, refusal: null })).toThrow();
  });
  test("accepts durable Windows Save with an explicit Apply-only refusal", () => {
    expect(parseDraftCapabilities(windowsSaveCapabilities)).toEqual(windowsSaveCapabilities);
    expect(() => parseDraftCapabilities({ ...windowsSaveCapabilities, refusal: null })).toThrow("capabilities contradict refusal");
    expect(() => parseDraftCapabilities({ ...windowsSaveCapabilities, durable_save_supported: false, apply_supported: true })).toThrow("Apply cannot be supported");
  });
  test("listing preserves recovery evidence and refuses pagination/ownership drift", () => {
    const summary = { draft_id: DRAFT_ID, revision: 1, content_revision: 1, scope: draft().scope,
      body_bytes: 0, has_pending_apply: false, has_applied_receipt: false };
    const listing = { schema: "kin.entity.drafts.v1", drafts: [summary], next_cursor: DRAFT_ID, recovery_evidence: [".pending-unknown"] };
    expect(parseDraftListing(listing, { entity_id: ENTITY_ID }).recovery_evidence).toEqual([".pending-unknown"]);
    expect(() => parseDraftListing(listing, { entity_id: DRAFT_ID })).toThrow();
    expect(() => parseDraftListing(listing, { after: DRAFT_ID })).toThrow();
    expect(() => parseDraftListing({ ...listing, next_cursor: ENTITY_ID }, {})).toThrow();
    expect(() => parseDraftListing({ ...listing, drafts: [summary, summary] }, {})).toThrow();
    expect(parseDraftListing({ ...listing, drafts: [], next_cursor: null }, {})).toMatchObject({ drafts: [] });
  });
});

describe("session expiry recovery evidence", () => {
  test("only the actual nested unresolved mutation refusal permits recovery", () => {
    const text = pendingError("request_session_expired: the bound session is not registered");
    expect(isDraftSessionExpired(new DraftToolError("kin_draft_apply", text))).toBe(true);
    expect(isDraftSessionExpired(new Error(text))).toBe(false);
    expect(isDraftSessionExpired(new DraftToolError("kin_draft_save", text))).toBe(false);
    for (const message of ["source_base_conflict", "request_capability_refused", "bad request_session_expired: text"]) {
      expect(isDraftSessionExpired(new DraftToolError("kin_draft_apply", pendingError(message)))).toBe(false);
    }
    const payload = JSON.parse(text);
    payload.mutation_result.isError = false;
    expect(isDraftSessionExpired(new DraftToolError("kin_draft_apply", JSON.stringify(payload)))).toBe(false);
    payload.code = "draft_apply_receipt_not_saved";
    payload.mutation_result.isError = true;
    expect(isDraftSessionExpired(new DraftToolError("kin_draft_apply", JSON.stringify(payload)))).toBe(false);
  });
  test("unwraps only the documented nested text envelope", () => {
    const message = "request_session_expired: the bound session is not registered";
    const nested = JSON.stringify({ message, _kin: runtimeEnvelope });
    expect(isDraftSessionExpired(new DraftToolError("kin_draft_apply", pendingError(nested)))).toBe(true);
    expect(isDraftSessionExpired(new DraftToolError("kin_draft_apply", pendingError(JSON.stringify({ message, extra: "ignored?", _kin: runtimeEnvelope }))))).toBe(false);
  });
  test("large refusal text is retained for diagnostics but not rendered into the UI", () => {
    const text = pendingError("source_base_conflict:" + "private draft ".repeat(1000));
    const error = new DraftToolError("kin_draft_apply", text);
    expect(error.message.length).toBeLessThan(700);
    expect(error.text).toBe(text);
    expect(error.code).toBe("draft_apply_unresolved");
  });
});

describe("universal MCP metadata and closed draft payload", () => {
  test("accepts real runtime metadata and retains additive metadata without altering the draft", () => {
    const metadata = { ...runtimeEnvelope, future_observation: { uninterpreted: true } };
    const response = splitDraftMcpPayload({ ...draft(), _kin: metadata });
    expect(response.envelope).toEqual(metadata);
    expect(parseEntityDraft(response.payload)).toEqual(draft());
    expect(() => parseEntityDraft(splitDraftMcpPayload({ ...draft(), surprise: true, _kin: metadata }).payload)).toThrow();
    expect(() => parseDraftSaved({ schema: "kin.entity.draft.saved.v1", already_saved: false, draft: { ...draft(), _kin: metadata } })).toThrow();
  });
  test.each([
    null, { envelope_version: 2, runtime: "repo-daemon" },
    { ...runtimeEnvelope, envelope_version: 3 }, { ...runtimeEnvelope, runtime: "invented" },
    { ...runtimeEnvelope, degraded: { workspace_mismatch: "false" } },
    { ...runtimeEnvelope, graph_state: { loaded: "true" } },
    { ...runtimeEnvelope, durability: { state: "recorded", live_entities: -1 } },
    { ...runtimeEnvelope, hydration_semantics: { standing: "current" } },
    { ...runtimeEnvelope, semantic_coverage: { indexed: 0, total: 0, pending: 0, complete: "true" } },
    { ...runtimeEnvelope, response: { max_chars: 5000, chars_before: 50, chars_after: 50, bounded: false, compact: false } },
  ])("refuses invalid known metadata %#", metadata => {
    expect(() => splitDraftMcpPayload({ ...draft(), _kin: metadata })).toThrow(DraftContractError);
  });
  test("uses budget wire names and never substitutes metadata freshness for source_base", () => {
    const result = splitDraftMcpPayload({ ...draft(), _kin: { ...runtimeEnvelope,
      response: { max_chars: 5000, chars_before_budget: 50, chars_after_budget: 50, bounded: false, compact: false },
      graph_as_of: "opaque-marker", verdict: { editable: true } } });
    expect(parseEntityDraft(result.payload).original_source_base).toEqual(sourceBase());
  });
});
