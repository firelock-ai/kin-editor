// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { createEntityDraft, DraftJournal, DraftTransport, EntityDraftSession } from "../entity-draft-session";
import type { EntityDraft, DraftCreate, DraftSave, DraftApply, DraftApplied } from "../entity-draft-contract";
import { DraftToolError } from "../entity-draft-contract";
import { pendingError } from "./fixtures/entity-draft";

const id = "11111111-1111-4111-8111-111111111111";
const source = { original_body: "fn value() { 1 }", original_source_base: {} } as Omit<DraftCreate, "draft_id" | "body">;
function draft(body = source.original_body, revision = 1): EntityDraft {
  return { schema: "kin.entity.draft.v1", draft_id: id, revision, content_revision: revision,
    scope: { repository_id: "repo", workspace_id: id, entity_id: id, owner: "local-bearer-v1" },
    original_body: source.original_body, original_source_base: source.original_source_base,
    body, previous_record_hash: null, request_hash: "hash", pending_apply: null, applied_receipt: null };
}

function journal(): DraftJournal & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, JSON.parse(JSON.stringify(value))); } };
}

function server() {
  let latest = draft();
  const saved = new Map<string, EntityDraft>();
  const client = {
    createDraft: jest.fn(async (request: DraftCreate) => ({ ...draft(request.body), draft_id: request.draft_id })),
    saveDraft: jest.fn(async (request: DraftSave) => {
      const key = JSON.stringify(request);
      if (saved.has(key)) return saved.get(key)!;
      if (request.expected_revision !== latest.revision) throw new Error("draft_revision_conflict");
      latest = { ...latest, revision: latest.revision + 1, content_revision: latest.revision + 1, body: request.body };
      saved.set(key, latest);
      return latest;
    }),
    readDraft: jest.fn(async () => latest),
    registerDraftSession: jest.fn(async (_sessionId: string) => undefined),
    applyDraft: jest.fn(async (_request: DraftApply): Promise<DraftApplied> => { throw new Error("not configured"); }),
  } satisfies DraftTransport;
  return { client, latest: () => latest, set: (value: EntityDraft) => { latest = value; } };
}

describe("editor durable draft session", () => {
  it("retains the original create UUID, source base and body after a lost reply and editor reload", async () => {
    const state = journal();
    const { client } = server();
    client.createDraft.mockRejectedValueOnce(new Error("reply lost"));
    await expect(createEntityDraft(client, state, "source", { ...source, body: "invalid (" })).rejects.toThrow("reply lost");
    const original = client.createDraft.mock.calls[0][0];
    await createEntityDraft(client, state, "source", { ...source, body: "a different buffer", original_body: "new source" });
    expect(client.createDraft.mock.calls[1][0]).toEqual(original);
    expect(state.values.size).toBe(0);
  });

  it.each(["", "invalid (", "\ufeffα\r\n🙂\u0000終"])('saves exact unfinished bytes %p only after daemon acknowledgement', async body => {
    const state = journal();
    const backend = server();
    const session = new EntityDraftSession(backend.latest(), backend.client, state, id);
    const result = await session.save(body);
    expect(result.body).toBe(body);
    expect(backend.latest().body).toBe(body);
    expect(backend.client.applyDraft).not.toHaveBeenCalled();
    expect(state.values.size).toBe(0);
  });

  it("recovers the exact lost Save before attempting newer text after a reload", async () => {
    const state = journal();
    const backend = server();
    const send = backend.client.saveDraft.getMockImplementation()!;
    backend.client.saveDraft.mockImplementationOnce(async request => { await send(request); throw new Error("zero reply bytes"); });
    await expect(new EntityDraftSession(backend.latest(), backend.client, state, id).save("first edit")).rejects.toThrow("zero reply bytes");
    const first = backend.client.saveDraft.mock.calls[0][0];
    const reopened = new EntityDraftSession(await backend.client.readDraft(), backend.client, state, id);
    await reopened.save("newer edit");
    expect(backend.client.saveDraft.mock.calls[1][0]).toEqual(first);
    expect(backend.client.saveDraft.mock.calls[2][0]).toEqual({ draft_id: id, expected_revision: 2, body: "newer edit" });
    expect(reopened.draft.body).toBe("newer edit");
  });

  it("does not borrow another editor's revision to overwrite its text", async () => {
    const backend = server();
    const first = new EntityDraftSession(backend.latest(), backend.client, journal(), "first");
    const secondState = journal();
    const second = new EntityDraftSession(backend.latest(), backend.client, secondState, "second");
    await first.save("first editor");
    await expect(second.save("second editor")).rejects.toThrow("draft_revision_conflict");
    expect(backend.latest().body).toBe("first editor");
    expect(second.draft.body).toBe(source.original_body);
    expect([...secondState.values.values()]).toEqual([{ draft_id: id, expected_revision: 1, body: "second editor" }]);
  });

  it("a later successful read does not silently turn a conflicting retry into a new request", async () => {
    const state = journal();
    const backend = server();
    backend.set(draft("other editor", 2));
    const old = new EntityDraftSession(draft(), backend.client, state, id);
    await expect(old.save("my edit")).rejects.toThrow("draft_revision_conflict");
    const reopened = new EntityDraftSession(backend.latest(), backend.client, state, id);
    await expect(reopened.save("changed again")).rejects.toThrow("draft_revision_conflict");
    expect(backend.client.saveDraft.mock.calls.map(call => call[0])).toEqual([
      { draft_id: id, expected_revision: 1, body: "my edit" },
      { draft_id: id, expected_revision: 1, body: "my edit" },
    ]);
  });

  it("does not dispatch when retaining the recovery invocation fails", async () => {
    const state = journal();
    state.update = async () => { throw new Error("editor state unavailable"); };
    const { client } = server();
    await expect(new EntityDraftSession(draft(), client, state, id).save("edit")).rejects.toThrow("editor state unavailable");
    expect(client.saveDraft).not.toHaveBeenCalled();
  });

  it("serializes overlapping Saves without losing either acknowledged revision", async () => {
    const backend = server();
    const session = new EntityDraftSession(draft(), backend.client, journal(), id);
    await Promise.all([session.save("first"), session.save("second")]);
    expect(backend.client.saveDraft.mock.calls.map(call => call[0].expected_revision)).toEqual([1, 2]);
    expect(session.draft.body).toBe("second");
  });

  it("keeps the original Apply invocation after failure, newer Save and editor reload", async () => {
    const backend = server();
    const state = journal();
    backend.client.applyDraft.mockImplementationOnce(async request => {
      backend.set({ ...backend.latest(), revision: 2, pending_apply: {
        requested_revision: request.expected_revision, draft_revision: 1, session_id: request.session_id,
        request_id: "permanent-key", arguments: {},
      } });
      throw new Error("request_session_expired");
    });
    const session = new EntityDraftSession(draft(), backend.client, state, id);
    await expect(session.apply()).rejects.toThrow("request_session_expired");
    const original = backend.client.applyDraft.mock.calls[0][0];
    await session.save("newer text");
    const reopened = new EntityDraftSession(backend.latest(), backend.client, state, id);
    await expect(reopened.resumeApply()).rejects.toThrow("not configured");
    expect(backend.client.applyDraft.mock.calls[1][0]).toEqual(original);
    expect(backend.client.registerDraftSession.mock.calls.map(call => call[0])).toEqual([original.session_id]);
    expect(reopened.draft.body).toBe("newer text");
  });

  it("does not adopt unrelated latest text when an Apply failure returns newer metadata", async () => {
    const backend = server();
    backend.set(draft("other writer", 2));
    const session = new EntityDraftSession(draft(), backend.client, journal(), id);
    await expect(session.apply()).rejects.toThrow("not configured");
    expect(session.draft.body).toBe(source.original_body);
    await expect(session.save("my text")).rejects.toThrow("draft_revision_conflict");
  });

  it("recovers an existing receipt before touching unavailable session registration", async () => {
    const backend = server();
    const state = journal();
    const request = { draft_id: id, expected_revision: 1, session_id: id };
    await state.update(`kin.draft.v1.${id}.apply`, request);
    backend.client.registerDraftSession.mockRejectedValue(new Error("registration unavailable"));
    backend.client.applyDraft.mockResolvedValue({ draft: backend.latest(), receipt_saved: true } as DraftApplied);
    await expect(new EntityDraftSession(draft(), backend.client, state, id).resumeApply()).resolves.toMatchObject({ receipt_saved: true });
    expect(backend.client.applyDraft).toHaveBeenCalledWith(request);
    expect(backend.client.registerDraftSession).not.toHaveBeenCalled();
    expect(state.values.size).toBe(0);
  });

  it("registers the original UUID only after narrow expiry evidence then retries exact Apply", async () => {
    const backend = server();
    const state = journal();
    const request = { draft_id: id, expected_revision: 1, session_id: id };
    await state.update(`kin.draft.v1.${id}.apply`, request);
    const order: string[] = [];
    backend.client.applyDraft.mockImplementationOnce(async () => {
      order.push("receipt-first");
      throw new DraftToolError("kin_draft_apply", pendingError("request_session_expired: the bound session is not registered"));
    }).mockImplementationOnce(async () => { order.push("exact-retry"); return { draft: draft(), receipt_saved: true } as DraftApplied; });
    backend.client.registerDraftSession.mockImplementation(async () => { order.push("register-original"); });
    await new EntityDraftSession(draft(), backend.client, state, id).resumeApply();
    expect(order).toEqual(["receipt-first", "register-original", "exact-retry"]);
    expect(backend.client.applyDraft.mock.calls.map(call => call[0])).toEqual([request, request]);
    expect(backend.client.registerDraftSession).toHaveBeenCalledWith(id);
  });

  it.each(["source_base_conflict", "request_capability_refused", "request_session_expired"])("does not register on generic refusal %s", async message => {
    const backend = server();
    const state = journal();
    await state.update(`kin.draft.v1.${id}.apply`, { draft_id: id, expected_revision: 1, session_id: id });
    backend.client.applyDraft.mockRejectedValue(new DraftToolError("kin_draft_apply", pendingError(message)));
    await expect(new EntityDraftSession(draft(), backend.client, state, id).resumeApply()).rejects.toThrow(message);
    expect(backend.client.registerDraftSession).not.toHaveBeenCalled();
    expect(state.values.size).toBe(1);
  });

  it("rebinds against exact history without borrowing the latest writer's revision", async () => {
    const old = server();
    const current = server();
    current.set(draft("other editor", 2));
    current.client.readDraft.mockResolvedValue(draft());
    const state = journal();
    const session = new EntityDraftSession(draft(), old.client, state, id);
    await session.rebind(current.client, () => undefined);
    expect(current.client.readDraft).toHaveBeenCalledWith(id, 1);
    await expect(session.save("my retained buffer")).rejects.toThrow("draft_revision_conflict");
    expect(current.client.saveDraft).toHaveBeenCalledWith({ draft_id: id, expected_revision: 1, body: "my retained buffer" });
    expect(old.client.saveDraft).not.toHaveBeenCalled();
    expect(session.draft.body).toBe(source.original_body);
  });

  it("recovers the exact lost Save through a replacement connection before saving newer text", async () => {
    const backend = server();
    const original = draft();
    const send = backend.client.saveDraft.getMockImplementation()!;
    backend.client.saveDraft.mockImplementationOnce(async request => { await send(request); throw new Error("lost reply"); });
    const state = journal();
    const session = new EntityDraftSession(original, backend.client, state, id);
    await expect(session.save("first edit")).rejects.toThrow("lost reply");
    const retainedRequest = backend.client.saveDraft.mock.calls[0][0];
    const next = { ...backend.client, readDraft: jest.fn(async () => original), saveDraft: jest.fn(send) };
    await session.rebind(next, () => undefined);
    await session.save("newer edit");
    expect(next.readDraft).toHaveBeenCalledWith(id, 1);
    expect(next.saveDraft.mock.calls.map(call => call[0])).toEqual([
      retainedRequest, { draft_id: id, expected_revision: 2, body: "newer edit" },
    ]);
    expect(backend.client.saveDraft).toHaveBeenCalledTimes(1);
    expect(session.draft.body).toBe("newer edit");
    expect(state.values.size).toBe(0);
  });

  it.each(["scope", "original_source_base", "body", "request_hash"])("refuses changed immutable %s when rebinding", async field => {
    const old = server();
    const current = server();
    current.client.readDraft.mockResolvedValue({ ...draft(), [field]: "replaced" } as EntityDraft);
    const session = new EntityDraftSession(draft(), old.client, journal(), id);
    await expect(session.rebind(current.client, () => undefined)).rejects.toThrow("exact saved identity");
    expect(current.client.saveDraft).not.toHaveBeenCalled();
    expect(current.client.applyDraft).not.toHaveBeenCalled();
  });
});
