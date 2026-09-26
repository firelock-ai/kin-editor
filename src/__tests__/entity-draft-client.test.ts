// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "child_process";
import { KinClient } from "../kin-client";
import { McpClient, McpToolError } from "../mcp-client";
import { DraftContractError, DraftToolError, isDraftSessionExpired, parseEntityDraft } from "../entity-draft-contract";
import actualAccountingApply from "./fixtures/entity-draft-applied-accounting.json";
import { EntityDraftSession } from "../entity-draft-session";
import { applied, actualAppliedRecord, capabilities, windowsSaveCapabilities, draft, sourceBase, originalBody, DRAFT_ID, ENTITY_ID, SESSION_ID, HASH, pendingError, runtimeEnvelope } from "./fixtures/entity-draft";

jest.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: { showWarningMessage: jest.fn() } }), { virtual: true });
jest.mock("child_process");
jest.mock("fs", () => ({ existsSync: () => false }));
jest.mock("../logger", () => ({ log: jest.fn(), logError: jest.fn() }));

function fixture(connected = true) {
  const callTool = jest.fn();
  const mcp = { isConnected: () => connected, callTool } as unknown as McpClient;
  return { client: new KinClient("/fixture/repo", mcp), callTool };
}
const saved = (value = draft()) => JSON.stringify({ schema: "kin.entity.draft.saved.v1", draft: value, already_saved: false });
const session = (started: boolean) => ({ session_id: SESSION_ID, status: "active",
  idle_timeout_secs: 1800, idle_reap_eligible_at: "2026-09-13T04:00:00Z",
  ...(started ? { started_at: "2026-09-13T03:30:00Z", capabilities: { can_write: true, can_commit: true } }
    : { heartbeat_at: "2026-09-13T03:30:00Z" }) });
const missingSession = (id = SESSION_ID) => new McpToolError("kin_session_heartbeat",
  `daemon heartbeat failed: HTTP 404 Not Found: session not found: ${id}. It was ended or expired after its idle timeout`);

beforeEach(() => jest.clearAllMocks());
afterEach(() => expect(execFile).not.toHaveBeenCalled());

describe("MCP-only durable draft client", () => {
  test.each([actualAppliedRecord, () => structuredClone(actualAccountingApply)])("actual persisted publication receipt clears the original Apply journal after client acknowledgement %#", async actualReply => {
    const { client, callTool } = fixture();
    const actual = actualReply();
    const original = actual.draft.applied_receipt!.attempt;
    const request = { draft_id: actual.draft_id, expected_revision: actual.requested_revision, session_id: original.session_id };
    const pending = new Map<string, unknown>([["kin.draft.v1.actual.apply", request]]);
    const journal = { get: <T>(key: string) => pending.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { if (value === undefined) pending.delete(key); else pending.set(key, value); } };
    callTool.mockResolvedValue(JSON.stringify({ ...actual, _kin: runtimeEnvelope }));
    const session = new EntityDraftSession(parseEntityDraft(actual.draft), client, journal, "actual");
    await expect(session.resumeApply()).resolves.toEqual(actual);
    expect(callTool.mock.calls).toEqual([["kin_draft_apply", request, 30000]]);
    expect(pending.size).toBe(0);
    expect(session.draft.applied_receipt?.receipt).toEqual(actual.receipt);
  });
  test("reads the actual top-level draft/capability envelope and preserves closed domain validation", async () => {
    const { client, callTool } = fixture();
    callTool.mockResolvedValueOnce(JSON.stringify({ ...draft(), _kin: runtimeEnvelope }));
    expect(await client.readDraft(DRAFT_ID)).toEqual(draft());
    callTool.mockResolvedValueOnce(JSON.stringify({ ...capabilities, _kin: runtimeEnvelope }));
    expect(await client.draftCapabilities()).toEqual(capabilities);
    callTool.mockResolvedValueOnce(JSON.stringify({ ...draft(), extra: "not metadata", _kin: runtimeEnvelope }));
    await expect(client.readDraft(DRAFT_ID)).rejects.toThrow(DraftContractError);
    callTool.mockResolvedValueOnce(JSON.stringify({ ...draft(), _kin: { ...runtimeEnvelope, runtime: "offline-in-process" } }));
    await expect(client.readDraft(DRAFT_ID)).rejects.toThrow("require the repository daemon");
  });
  test("sends exact Create and Save fields, including invalid/empty/Unicode text", async () => {
    const { client, callTool } = fixture();
    const create = { draft_id: DRAFT_ID, original_body: originalBody, original_source_base: sourceBase(), body: "" };
    callTool.mockResolvedValueOnce(saved());
    expect(await client.createDraft(create)).toEqual(draft());
    expect(callTool.mock.calls[0]).toEqual(["kin_draft_create", create, 30000]);
    const save = { draft_id: DRAFT_ID, expected_revision: 1, body: "invalid (\n🚀" };
    const expected = draft({ revision: 2, content_revision: 2, previous_record_hash: HASH, body: save.body });
    callTool.mockResolvedValueOnce(saved(expected));
    expect(await client.saveDraft(save)).toEqual(expected);
    expect(callTool.mock.calls[1]).toEqual(["kin_draft_save", save, 30000]);
  });
  test("lost reply retry retains the exact request and accepts original revision after later saves", async () => {
    const { client, callTool } = fixture();
    const request = { draft_id: DRAFT_ID, expected_revision: 1, body: "later" };
    callTool.mockRejectedValueOnce(new Error("lost response"));
    await expect(client.saveDraft(request)).rejects.toThrow("lost response");
    const expected = draft({ revision: 2, content_revision: 2, previous_record_hash: HASH, body: request.body });
    callTool.mockResolvedValueOnce(JSON.stringify({ schema: "kin.entity.draft.saved.v1", draft: expected, already_saved: true }));
    expect(await client.saveDraft(request)).toEqual(expected);
    expect(callTool.mock.calls[0]).toEqual(callTool.mock.calls[1]);
  });
  test("reads latest/earlier drafts and lists deleted targets without entity/session lookup", async () => {
    const { client, callTool } = fixture();
    callTool.mockResolvedValueOnce(JSON.stringify(draft())).mockResolvedValueOnce(JSON.stringify(draft()));
    await client.readDraft(DRAFT_ID); await client.readDraft(DRAFT_ID, 1);
    expect(callTool.mock.calls.slice(0, 2)).toEqual([
      ["kin_draft_read", { draft_id: DRAFT_ID }, 30000],
      ["kin_draft_read", { draft_id: DRAFT_ID, revision: 1 }, 30000],
    ]);
    callTool.mockResolvedValueOnce(JSON.stringify({ schema: "kin.entity.drafts.v1", drafts: [], next_cursor: null, recovery_evidence: ["uncertain"] }));
    expect(await client.listDrafts({ entity_id: ENTITY_ID, after: DRAFT_ID, limit: 12 })).toMatchObject({ recovery_evidence: ["uncertain"] });
    expect(callTool).toHaveBeenLastCalledWith("kin_draft_list", { entity_id: ENTITY_ID, after: DRAFT_ID, limit: 12 }, 30000);
  });
  test("capabilities require only MCP and preserve platform refusal", async () => {
    const { client, callTool } = fixture();
    callTool.mockResolvedValueOnce(JSON.stringify(capabilities));
    expect(await client.draftCapabilities()).toEqual(capabilities);
    expect(callTool).toHaveBeenCalledWith("kin_draft_capabilities", {}, 30000);
  });
  test("preserves Windows Save support and its Apply refusal across the MCP boundary", async () => {
    const { client, callTool } = fixture();
    callTool.mockResolvedValueOnce(JSON.stringify({ ...windowsSaveCapabilities, _kin: runtimeEnvelope }));
    expect(await client.draftCapabilities()).toEqual(windowsSaveCapabilities);
    const request = { draft_id: DRAFT_ID, expected_revision: 1, body: "unfinished Windows draft (\r\n🧭\0" };
    const expected = draft({ revision: 2, content_revision: 2, previous_record_hash: HASH, body: request.body });
    callTool.mockResolvedValueOnce(saved(expected));
    expect(await client.saveDraft(request)).toEqual(expected);
    expect(callTool.mock.calls).toEqual([
      ["kin_draft_capabilities", {}, 30000], ["kin_draft_save", request, 30000],
    ]);
  });
  test("Apply binds the exact receipt and never registers a session implicitly", async () => {
    const { client, callTool } = fixture();
    const expected = applied();
    callTool.mockResolvedValueOnce(JSON.stringify(expected));
    const request = { draft_id: DRAFT_ID, expected_revision: 1, session_id: SESSION_ID };
    expect(await client.applyDraft(request)).toEqual(expected);
    expect(callTool.mock.calls).toEqual([["kin_draft_apply", request, 30000]]);
    callTool.mockResolvedValueOnce(JSON.stringify({ ...expected, receipt: { ...expected.receipt, request_id: "another" } }));
    await expect(client.applyDraft(request)).rejects.toThrow("another request");
  });
  test("historical Apply binds the immutable pending revision when latest metadata has advanced", async () => {
    const { client, callTool } = fixture();
    const original = applied();
    const historical = draft({ revision: 2, previous_record_hash: HASH, pending_apply: original.draft.applied_receipt!.attempt });
    const latest = { ...original, current_text_applied: false, draft: draft({ revision: 6, content_revision: 4, previous_record_hash: HASH, body: "newer text" }) };
    callTool.mockResolvedValueOnce(JSON.stringify(latest)).mockResolvedValueOnce(JSON.stringify(historical));
    expect(await client.applyDraft({ draft_id: DRAFT_ID, expected_revision: 1, session_id: SESSION_ID })).toEqual(latest);
    expect(callTool.mock.calls[1]).toEqual(["kin_draft_read", { draft_id: DRAFT_ID, revision: 2 }, 30000]);
  });
  test("MCP refuses remain useful typed errors, not write fallback", async () => {
    const { client, callTool } = fixture();
    callTool.mockRejectedValue(new McpToolError("kin_draft_apply", pendingError("request_session_expired: the bound session is not registered")));
    let error: unknown;
    try { await client.applyDraft({ draft_id: DRAFT_ID, expected_revision: 1, session_id: SESSION_ID }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DraftToolError);
    expect(isDraftSessionExpired(error)).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  test("closed request guards reject unknown fields and unsafe revisions before dispatch", async () => {
    const { client, callTool } = fixture();
    await expect(client.saveDraft({ draft_id: DRAFT_ID, expected_revision: Number.MAX_SAFE_INTEGER, body: "" })).rejects.toThrow(DraftContractError);
    await expect(client.saveDraft({ draft_id: DRAFT_ID, expected_revision: 1, body: "", extra: true } as never)).rejects.toThrow(DraftContractError);
    await expect(client.listDrafts({ limit: 201 })).rejects.toThrow(DraftContractError);
    expect(callTool).not.toHaveBeenCalled();
  });
  test("wrong acknowledged body/revision/id cannot masquerade as a save/read", async () => {
    const { client, callTool } = fixture();
    callTool.mockResolvedValueOnce(saved(draft({ revision: 2, content_revision: 2, previous_record_hash: HASH, body: "different" })));
    await expect(client.saveDraft({ draft_id: DRAFT_ID, expected_revision: 1, body: "submitted" })).rejects.toThrow(DraftContractError);
    callTool.mockResolvedValueOnce(JSON.stringify(draft({ draft_id: ENTITY_ID })));
    await expect(client.readDraft(DRAFT_ID)).rejects.toThrow(DraftContractError);
  });
  test("all draft tools refuse a disconnected MCP transport without a subprocess", async () => {
    const { client, callTool } = fixture(false);
    for (const run of [() => client.draftCapabilities(), () => client.listDrafts(), () => client.readDraft(DRAFT_ID),
      () => client.saveDraft({ draft_id: DRAFT_ID, expected_revision: 1, body: "" }),
      () => client.createDraft({ draft_id: DRAFT_ID, original_body: originalBody, original_source_base: sourceBase(), body: "" }),
      () => client.applyDraft({ draft_id: DRAFT_ID, expected_revision: 1, session_id: SESSION_ID }),
      () => client.registerDraftSession(SESSION_ID)]) await expect(run()).rejects.toThrow("MCP connection");
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("original draft session registration", () => {
  test("an existing daemon session is heartbeated without another start", async () => {
    const { client, callTool } = fixture();
    callTool.mockResolvedValueOnce(JSON.stringify(session(false)));
    await client.registerDraftSession(SESSION_ID);
    expect(callTool.mock.calls).toEqual([["kin_session_heartbeat", { session_id: SESSION_ID }, 30000]]);
  });
  test("a precise missing session registers the caller's same UUID and scoped capabilities", async () => {
    const { client, callTool } = fixture();
    callTool.mockRejectedValueOnce(missingSession()).mockResolvedValueOnce(JSON.stringify(session(true)));
    await client.registerDraftSession(SESSION_ID);
    expect(callTool.mock.calls[1]).toEqual(["kin_session_start", {
      session_id: SESSION_ID, vendor: "kin-editor", client_name: "Kin Editor", transport: "mcp", cwd: "/fixture/repo",
      capabilities: { can_read: true, can_write: true, can_execute: false, can_branch: false, can_commit: true, max_concurrent_intents: 1 },
    }, 30000]);
  });
  test("real MCP wrapped heartbeat errors retain the exact 404 recovery signal", async () => {
    const { client, callTool } = fixture();
    callTool.mockRejectedValueOnce(new McpToolError("kin_session_heartbeat", JSON.stringify({
      message: missingSession().text, _kin: runtimeEnvelope,
    }))).mockResolvedValueOnce(JSON.stringify({ ...session(true), _kin: runtimeEnvelope }));
    await client.registerDraftSession(SESSION_ID);
    expect(callTool.mock.calls[1][1].session_id).toBe(SESSION_ID);
  });
  test.each([new Error("unreachable"), missingSession(DRAFT_ID),
    new McpToolError("kin_session_heartbeat", "daemon heartbeat failed: HTTP 403 Forbidden: session not found"),
    new McpToolError("kin_session_heartbeat", "server mentioned request_session_expired elsewhere")])("genuine or unbound errors never start a replacement %#", async error => {
    const { client, callTool } = fixture(); callTool.mockRejectedValueOnce(error);
    await expect(client.registerDraftSession(SESSION_ID)).rejects.toThrow();
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  test("offline liveness, wrong UUID and refused write capabilities are not successful registration", async () => {
    for (const response of [{ session_id: SESSION_ID, status: "alive" }, { ...session(false), session_id: DRAFT_ID }]) {
      const { client, callTool } = fixture(); callTool.mockResolvedValueOnce(JSON.stringify(response));
      await expect(client.registerDraftSession(SESSION_ID)).rejects.toThrow(DraftContractError);
      expect(callTool).toHaveBeenCalledTimes(1);
    }
    const { client, callTool } = fixture();
    callTool.mockRejectedValueOnce(missingSession()).mockResolvedValueOnce(JSON.stringify({ ...session(true), capabilities: { can_write: false, can_commit: true } }));
    await expect(client.registerDraftSession(SESSION_ID)).rejects.toThrow("lacks write or commit");
  });
});
