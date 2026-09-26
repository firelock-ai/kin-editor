// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { join } from "path";
import { parseDraftCapabilities } from "../entity-draft-contract";
import { windowsSaveCapabilities } from "./fixtures/entity-draft";

class FakeFileSystemError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}

jest.mock(
  "vscode",
  () => {
    class EventEmitter {
      private handlers: Array<(value: unknown) => void> = [];
      event = (handler: (value: unknown) => void) => {
        this.handlers.push(handler);
        return { dispose: () => undefined };
      };
      fire = (value: unknown) => {
        for (const handler of this.handlers) {
          handler(value);
        }
      };
      dispose = () => undefined;
    }

    class Disposable {
      constructor(public callOnDispose: () => void) {}
      dispose() {
        this.callOnDispose();
      }
    }

    class Range {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number
      ) {}
    }

    class Diagnostic {
      source: string | undefined;
      code: string | undefined;
      constructor(
        public range: Range,
        public message: string,
        public severity: number
      ) {}
    }

    const stringifyUri = (parts: {
      authority: string;
      path: string;
      query: string;
    }) =>
      `kin://${parts.authority}${parts.path}${parts.query ? `?${parts.query}` : ""}`;

    const makeUri = (parts: {
      scheme?: string;
      authority: string;
      path: string;
      query?: string;
    }) => ({
      scheme: parts.scheme ?? "kin",
      authority: parts.authority,
      path: parts.path,
      query: parts.query ?? "",
      toString: () =>
        stringifyUri({
          authority: parts.authority,
          path: parts.path,
          query: parts.query ?? "",
        }),
    });

    return {
      EventEmitter,
      Disposable,
      Range,
      Diagnostic,
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
      FileType: { Unknown: 0, File: 1, Directory: 2 },
      FileChangeType: { Changed: 0, Created: 1, Deleted: 2 },
      FilePermission: { Readonly: 1 },
      FileSystemError: {
        FileNotFound: (detail: unknown) =>
          new FakeFileSystemError("FileNotFound", String(detail)),
        FileNotADirectory: (detail: unknown) =>
          new FakeFileSystemError("FileNotADirectory", String(detail)),
        NoPermissions: (detail: unknown) =>
          new FakeFileSystemError("NoPermissions", String(detail)),
        Unavailable: (detail: unknown) =>
          new FakeFileSystemError("Unavailable", String(detail)),
      },
      Uri: {
        from: makeUri,
        parse: (value: string) => {
          const [head, query = ""] = value.split("?");
          const withoutScheme = head.replace(/^kin:\/\//, "");
          const slash = withoutScheme.indexOf("/");
          return makeUri({
            authority: withoutScheme.slice(0, slash),
            path: withoutScheme.slice(slash),
            query,
          });
        },
        file: (fsPath: string) => ({ fsPath }),
      },
      languages: {
        createDiagnosticCollection: () => ({
          set: jest.fn(),
          delete: jest.fn(),
          clear: jest.fn(),
          dispose: jest.fn(),
        }),
      },
      window: { createOutputChannel: () => ({ appendLine: jest.fn() }) },
      workspace: { getConfiguration: () => ({ get: () => undefined }) },
    };
  },
  { virtual: true }
);

import * as vscode from "vscode";
import {
  KinEntityFileSystemProvider,
  WRITE_PATH_REFUSAL,
  entityUri,
  draftUri,
  renderEntityContent,
  workspaceKeyFor,
} from "../entity-viewer";
import { GraphDiagnostics } from "../graph-diagnostics";
import { TRUNCATION_MARKER, readEntitySource } from "../graph-entity";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "mcp", "entity-source.json"), "utf8")
) as { payload: Record<string, unknown> };

const ENTITY_ID = String(fixture.payload.id);
const WORKSPACE = "/repo";
const KEY = workspaceKeyFor(WORKSPACE);

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    entitySource: jest.fn().mockResolvedValue({
      document: readEntitySource(JSON.stringify(fixture.payload)),
      findings: [],
    }),
    entityRelations: jest.fn().mockResolvedValue({
      neighborhood: { truncated: false, relations: [] },
      findings: [],
    }),
    graphStatusFindings: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeProvider(client: ReturnType<typeof makeClient>, journal?: import("../entity-draft-session").DraftJournal) {
  const collection = {
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
  };
  const diagnostics = new GraphDiagnostics(collection as any);
  const provider = new KinEntityFileSystemProvider(diagnostics, journal);
  provider.setWorkspaces([
    { key: KEY, workspacePath: WORKSPACE, client },
  ]);
  return { provider, collection };
}

const uri = () =>
  entityUri({
    workspaceKey: KEY,
    entityId: ENTITY_ID,
    kind: "Method",
    name: "KinClient::entitySource",
    language: "rust",
  });

describe("the kin:// entity document", () => {
  it("serves the entity's body from the graph, byte for byte", async () => {
    const client = makeClient();
    const { provider } = makeProvider(client);

    const bytes = await provider.readFile(uri());

    expect(Buffer.from(bytes).toString("utf8")).toBe(fixture.payload.body);
    expect(client.entitySource).toHaveBeenCalledWith(ENTITY_ID);
  });

  it("appends nothing to a body the daemon did not cut", () => {
    const document = readEntitySource(JSON.stringify(fixture.payload));
    expect(renderEntityContent(document)).toBe(document.body);
  });

  it("shows the truncation and the remedy when the daemon did cut one", () => {
    // The failure this guards: a clipped body rendered as the entity's source,
    // which reads as a complete function that simply ends early.
    const document = readEntitySource(
      JSON.stringify({
        ...fixture.payload,
        body: `fn head() {\n${TRUNCATION_MARKER}`,
      })
    );
    const content = renderEntityContent(document);

    expect(content).toContain("fn head() {");
    expect(content).toContain("TRUNCATED");
    expect(content).toContain("kin_artifact_read");
  });

  it("reports the document as readonly and sized to what it served", async () => {
    const { provider } = makeProvider(makeClient());

    const stat = await provider.stat(uri());

    expect(stat.type).toBe(vscode.FileType.File);
    expect(stat.permissions).toBe(vscode.FilePermission.Readonly);
    expect(stat.size).toBe(Buffer.byteLength(String(fixture.payload.body)));
  });

  it("reads each entity once for the stat and read pair the editor makes", async () => {
    const client = makeClient();
    const { provider } = makeProvider(client);

    await provider.stat(uri());
    await provider.readFile(uri());

    expect(client.entitySource).toHaveBeenCalledTimes(1);
  });

  it("publishes the daemon's findings on the document", async () => {
    const client = makeClient({
      entitySource: jest.fn().mockResolvedValue({
        document: readEntitySource(JSON.stringify(fixture.payload)),
        findings: [
          {
            code: "degraded.enrichment_shortfall",
            severity: "warning" as const,
            message: "the sweep did not finish",
          },
        ],
      }),
      graphStatusFindings: jest.fn().mockResolvedValue([
        {
          code: "graph_status.completion_unattested",
          severity: "info" as const,
          message: "no attestation",
        },
      ]),
    });
    const { provider, collection } = makeProvider(client);

    await provider.readFile(uri());

    expect(collection.set).toHaveBeenCalledTimes(1);
    const [, diagnostics] = collection.set.mock.calls[0];
    expect(diagnostics.map((d: vscode.Diagnostic) => d.code).sort()).toEqual([
      "degraded.enrichment_shortfall",
      "graph_status.completion_unattested",
    ]);
    expect(diagnostics[0].source).toBe("kin");
    expect(diagnostics[0].severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it("still serves the body when the relations read fails, and says so", async () => {
    const client = makeClient({
      entityRelations: jest.fn().mockRejectedValue(new Error("timed out")),
    });
    const { provider } = makeProvider(client);

    await provider.readFile(uri());

    // An absent neighborhood is what the hover renders as "the read did not
    // answer" rather than as "no relations".
    expect(provider.viewFor(uri())?.neighborhood).toBeUndefined();
    expect(provider.viewFor(uri())?.document.body).toBe(fixture.payload.body);
  });

  it("refuses rather than reading a file when the graph cannot answer", async () => {
    // The whole point of the scheme: there is no fallback to open the file
    // with, because a file read here would be indistinguishable from a working
    // viewer while showing bytes graph truth never served.
    const client = makeClient({
      entitySource: jest
        .fn()
        .mockRejectedValue(new Error("Entity not found: dead-id")),
    });
    const { provider } = makeProvider(client);

    await expect(provider.readFile(uri())).rejects.toThrow(
      "Entity not found: dead-id"
    );
  });

  it("refuses a URI with no entity id", async () => {
    const { provider } = makeProvider(makeClient());
    const bare = vscode.Uri.from({
      scheme: "kin",
      authority: KEY,
      path: "/Method/x.rs",
      query: "",
    });

    await expect(provider.readFile(bare)).rejects.toMatchObject({
      code: "FileNotFound",
    });
  });

  it("refuses an entity whose workspace is no longer open", async () => {
    const { provider } = makeProvider(makeClient());
    provider.setWorkspaces([]);

    await expect(provider.readFile(uri())).rejects.toThrow(
      "no longer open"
    );
  });

  it("refuses every write with the reason, not with a bare permission error", async () => {
    const { provider } = makeProvider(makeClient());

    for (const attempt of [
      () => provider.writeFile(uri(), Buffer.from("edited"), { create: false, overwrite: true }),
      () => provider.delete(uri()),
      () => provider.rename(uri()),
    ]) {
      expect(attempt).toThrow(WRITE_PATH_REFUSAL.slice(0, 48));
    }
    expect(WRITE_PATH_REFUSAL).toContain("Save preserves draft text");
  });

  it("is not a directory tree", () => {
    const { provider } = makeProvider(makeClient());
    expect(() => provider.readDirectory(uri())).toThrow();
  });
});

describe("invalidating open entity documents", () => {
  it("re-reads after the graph changes rather than serving the old body", async () => {
    const client = makeClient();
    const { provider } = makeProvider(client);
    const changed: unknown[] = [];
    provider.onDidChangeFile((events) => changed.push(events));

    await provider.readFile(uri());
    provider.invalidateAll();
    await provider.readFile(uri());

    expect(changed).toHaveLength(1);
    // A second read is the point: without it the tab keeps showing a body the
    // graph may no longer hold.
    expect(client.entitySource).toHaveBeenCalledTimes(2);
  });

  it("clears a closed document's diagnostics instead of keeping them forever", async () => {
    const client = makeClient({
      graphStatusFindings: jest.fn().mockResolvedValue([
        {
          code: "graph_status.completion_unattested",
          severity: "info" as const,
          message: "no attestation",
        },
      ]),
    });
    const { provider, collection } = makeProvider(client);

    await provider.readFile(uri());
    expect(collection.set).toHaveBeenCalledTimes(1);

    provider.forget(uri());

    // A user browsing the graph opens a lot of entities, and findings that
    // outlive their document bury the ones for the entity in front of them.
    expect(collection.delete).toHaveBeenCalledTimes(1);
    expect(provider.viewFor(uri())).toBeUndefined();
  });

  it("does not clear diagnostics for a document it never served", () => {
    const { provider, collection } = makeProvider(makeClient());
    provider.forget(uri());
    expect(collection.delete).not.toHaveBeenCalled();
  });

  it("fires nothing when no entity document is open", () => {
    const { provider } = makeProvider(makeClient());
    const changed: unknown[] = [];
    provider.onDidChangeFile((events) => changed.push(events));

    provider.invalidateAll();

    expect(changed).toHaveLength(0);
  });

  it("stops follow-up source reads when a workspace disappears during the source request", async () => {
    let finish!: (value: any) => void;
    const client = makeClient({ entitySource: jest.fn(() => new Promise(resolve => { finish = resolve; })) });
    const { provider } = makeProvider(client);
    const reading = provider.readFile(uri());
    const refusal = expect(reading).rejects.toThrow("connection or document changed");
    provider.setWorkspaces([]);
    finish({ document: readEntitySource(JSON.stringify(fixture.payload)), findings: [] });
    await refusal;
    expect(client.entityRelations).not.toHaveBeenCalled();
    expect(client.graphStatusFindings).not.toHaveBeenCalled();
    expect(provider.viewFor(uri())).toBeUndefined();
  });
});

describe("workspace keys", () => {
  it("are stable for a path and different between paths", () => {
    expect(workspaceKeyFor("/repo")).toBe(workspaceKeyFor("/repo"));
    expect(workspaceKeyFor("/repo")).not.toBe(workspaceKeyFor("/other"));
    expect(workspaceKeyFor("/repo")).toMatch(/^[0-9a-f]{16}$/);
  });
});


describe("durable kin:// draft documents", () => {
  const draftId = "11111111-1111-4111-8111-111111111111";
  function setup(body = "unfinished (") {
    let draft: any = { schema: "kin.entity.draft.v1", draft_id: draftId, revision: 1, content_revision: 1,
      body, original_body: String(fixture.payload.body), original_source_base: {},
      scope: { entity_id: ENTITY_ID }, pending_apply: null, applied_receipt: null };
    const values = new Map<string, unknown>();
    const journal = { get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); } };
    const client = makeClient({
      readDraft: jest.fn(async () => draft),
      draftCapabilities: jest.fn(async () => ({ durable_save_supported: true })),
      saveDraft: jest.fn(async (request: any) => {
        if (request.expected_revision !== draft.revision) throw new Error("draft_revision_conflict");
        draft = { ...draft, revision: draft.revision + 1, content_revision: draft.revision + 1, body: request.body };
        return draft;
      }),
    });
    const providerState = makeProvider(client, journal);
    return { ...providerState, client, journal, target: draftUri(uri(), draftId), getDraft: () => draft };
  }

  it("reopens retained draft bytes without asking a deleted live entity for source", async () => {
    const { provider, target, client } = setup();
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe("unfinished (");
    expect(client.entitySource).not.toHaveBeenCalled();
    expect(client.entityRelations).not.toHaveBeenCalled();
    expect((await provider.stat(target)).permissions).toBeUndefined();
  });

  it.each(["", "invalid (", "\ufeffα\r\n🙂\u0000終", `unfinished\n${TRUNCATION_MARKER}`])("saves draft text exactly: %p", async body => {
    const { provider, target, getDraft } = setup();
    await provider.readFile(target);
    await provider.writeFile(target, Buffer.from(body), { create: false, overwrite: true });
    expect(getDraft().body).toBe(body);
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe(body);
    expect((await provider.stat(target)).permissions).toBeUndefined();
  });

  it("refuses malformed UTF-8 before calling Save", async () => {
    const { provider, target, client } = setup();
    await provider.readFile(target);
    expect(() => provider.writeFile(target, Uint8Array.from([0xc3, 0x28]), { create: false, overwrite: true })).toThrow("not valid UTF-8");
    expect(client.saveDraft).not.toHaveBeenCalled();
  });

  it("does not replace draft text or fire a graph-change event for its URI", async () => {
    const { provider, target } = setup();
    await provider.readFile(target);
    const events: vscode.FileChangeEvent[] = [];
    provider.onDidChangeFile(batch => events.push(...batch));
    provider.invalidateAll();
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe("unfinished (");
    expect(events).toEqual([]);
  });

  it("keeps prior acknowledged text and recovery request when Save fails", async () => {
    const { provider, target, client, journal } = setup("previous");
    await provider.readFile(target);
    client.saveDraft.mockRejectedValueOnce(new Error("quota"));
    await expect(provider.writeFile(target, Buffer.from("my unsaved text"), { create: false, overwrite: true })).rejects.toThrow("Save was not acknowledged");
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe("previous");
    expect(journal.get(`kin.draft.v1.${target.toString()}.save`)).toEqual({ draft_id: draftId, expected_revision: 1, body: "my unsaved text" });
  });

  it("keeps unsupported-storage drafts readable without a Save guarantee", async () => {
    const { provider, target, client } = setup();
    client.draftCapabilities.mockResolvedValue({ durable_save_supported: false });
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe("unfinished (");
    expect((await provider.stat(target)).permissions).toBe(vscode.FilePermission.Readonly);
    await expect(provider.writeFile(target, Buffer.from("changed"), { create: false, overwrite: true })).rejects.toThrow(WRITE_PATH_REFUSAL);
    expect(client.saveDraft).not.toHaveBeenCalled();
  });

  it("keeps Windows drafts writable when only Apply has a platform refusal", async () => {
    const { provider, target, client, getDraft } = setup();
    client.draftCapabilities.mockResolvedValue(parseDraftCapabilities(windowsSaveCapabilities));
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe("unfinished (");
    expect((await provider.stat(target)).permissions).toBeUndefined();
    const body = "unfinished Windows draft (\r\n🧭\0";
    await provider.writeFile(target, Buffer.from(body), { create: false, overwrite: true });
    expect(client.saveDraft).toHaveBeenCalledWith({ draft_id: draftId, expected_revision: 1, body });
    expect(getDraft().body).toBe(body);
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe(body);
    expect((await provider.stat(target)).permissions).toBeUndefined();
  });

  it("makes an explicit older revision a read-only recovery view", async () => {
    const { provider, client } = setup();
    const target = draftUri(uri(), draftId, 1);
    await provider.readFile(target);
    expect(client.readDraft).toHaveBeenCalledWith(draftId, 1);
    expect((await provider.stat(target)).permissions).toBe(vscode.FilePermission.Readonly);
    expect(() => provider.writeFile(target, Buffer.from("changed"), { create: false, overwrite: true })).toThrow(WRITE_PATH_REFUSAL);
  });

  it("refuses cached draft access after its owning workspace is removed", async () => {
    const { provider, target } = setup();
    await provider.readFile(target);
    provider.setWorkspaces([]);
    await expect(provider.readFile(target)).rejects.toThrow("no longer open");
  });

  it("rebinds a retained buffer to the re-added workspace without changing its CAS", async () => {
    const { provider, target, client, getDraft } = setup();
    await provider.readFile(target);
    const retained = getDraft();
    provider.setWorkspaces([]);
    const current = makeClient({
      readDraft: jest.fn(async () => retained),
      draftCapabilities: jest.fn(async () => ({ durable_save_supported: true })),
      saveDraft: jest.fn(async (request: any) => ({ ...retained, revision: 2, content_revision: 2, body: request.body })),
    });
    provider.setWorkspaces([{ key: KEY, workspacePath: WORKSPACE, client: current }]);
    provider.invalidateAll();
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe(retained.body);
    expect(current.readDraft).toHaveBeenCalledWith(draftId, 1);
    await provider.writeFile(target, Buffer.from("retained unsaved buffer"), { create: false, overwrite: true });
    expect(current.saveDraft).toHaveBeenCalledWith({ draft_id: draftId, expected_revision: 1, body: "retained unsaved buffer" });
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(Buffer.from(await provider.readFile(target)).toString()).toBe("retained unsaved buffer");
  });

  it("refuses a replacement repository while preserving its draft cache and pending Save", async () => {
    const { provider, target, client, getDraft, journal } = setup();
    await provider.readFile(target);
    client.saveDraft.mockRejectedValueOnce(new Error("lost reply"));
    await expect(provider.writeFile(target, Buffer.from("my text"), { create: false, overwrite: true })).rejects.toThrow("lost reply");
    const pending = journal.get(`kin.draft.v1.${target.toString()}.save`);
    const current = makeClient({
      readDraft: jest.fn(async () => ({ ...getDraft(), scope: { ...getDraft().scope, repository_id: "different-repository" } })),
      draftCapabilities: jest.fn(), saveDraft: jest.fn(), applyDraft: jest.fn(),
    });
    provider.setWorkspaces([{ key: KEY, workspacePath: WORKSPACE, client: current }]);
    await expect(provider.writeFile(target, Buffer.from("my newer text"), { create: false, overwrite: true })).rejects.toThrow("exact saved identity");
    await expect(provider.applyDraft(target)).rejects.toThrow("exact saved identity");
    expect(provider.viewFor(target)?.content).toBe("unfinished (");
    expect(journal.get(`kin.draft.v1.${target.toString()}.save`)).toEqual(pending);
    expect(current.saveDraft).not.toHaveBeenCalled();
    expect(current.applyDraft).not.toHaveBeenCalled();
  });

  it("refuses rebinding when that workspace disappears during immutable revision verification", async () => {
    const { provider, target, getDraft } = setup();
    await provider.readFile(target);
    let finish!: (value: any) => void;
    const current = makeClient({ readDraft: jest.fn(() => new Promise(resolve => { finish = resolve; })),
      draftCapabilities: jest.fn(), saveDraft: jest.fn(), applyDraft: jest.fn() });
    provider.setWorkspaces([{ key: KEY, workspacePath: WORKSPACE, client: current }]);
    const saving = provider.writeFile(target, Buffer.from("retained text"), { create: false, overwrite: true });
    const refusal = expect(saving).rejects.toThrow("connection or document changed");
    while (!finish) await Promise.resolve();
    provider.setWorkspaces([]);
    finish(getDraft());
    await refusal;
    expect(current.saveDraft).not.toHaveBeenCalled();
    expect(current.draftCapabilities).not.toHaveBeenCalled();
    expect(provider.viewFor(target)?.content).toBe("unfinished (");
  });

  it.each(["remove", "close"])("discards a draft read that completes after %s", async action => {
    const { provider, target, client, getDraft } = setup();
    let finish!: (value: any) => void;
    client.readDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = provider.readFile(target);
    const refusal = expect(reading).rejects.toThrow("connection or document changed");
    if (action === "remove") provider.setWorkspaces([]);
    else provider.forget(target);
    finish(getDraft());
    await refusal;
    expect(provider.viewFor(target)).toBeUndefined();
    expect(provider.draftFor(target)).toBeUndefined();
    expect(client.draftCapabilities).not.toHaveBeenCalled();
  });

  it("does not let a stale read replace the new workspace's in-flight read", async () => {
    const { provider, target, client, getDraft } = setup();
    let finishOld!: (value: any) => void;
    let finishNew!: (value: any) => void;
    client.readDraft.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const old = provider.readFile(target);
    const refusal = expect(old).rejects.toThrow("connection or document changed");
    const current = makeClient({ readDraft: jest.fn(() => new Promise(resolve => { finishNew = resolve; })),
      draftCapabilities: jest.fn(async () => ({ durable_save_supported: true })) });
    provider.setWorkspaces([{ key: KEY, workspacePath: WORKSPACE, client: current }]);
    const next = provider.readFile(target);
    finishOld(getDraft());
    await refusal;
    const duplicate = provider.readFile(target);
    finishNew(getDraft());
    await Promise.all([next, duplicate]);
    expect(current.readDraft).toHaveBeenCalledTimes(1);
    expect(client.draftCapabilities).not.toHaveBeenCalled();
  });

  it("blocks a queued Save if the workspace disappears while journaling", async () => {
    const { provider, target, client, journal } = setup();
    await provider.readFile(target);
    const persist = journal.update;
    let finish!: () => void;
    journal.update = async (key, value) => { await persist(key, value); await new Promise<void>(resolve => { finish = resolve; }); };
    const saving = provider.writeFile(target, Buffer.from("keep me"), { create: false, overwrite: true });
    const refusal = expect(saving).rejects.toThrow("connection or document changed");
    while (!finish) await Promise.resolve();
    provider.setWorkspaces([]);
    finish();
    await refusal;
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(journal.get(`kin.draft.v1.${target.toString()}.save`)).toMatchObject({ body: "keep me", expected_revision: 1 });
  });

  it("acknowledges a completed Save after close without recreating the view", async () => {
    const { provider, target, client, getDraft } = setup();
    await provider.readFile(target);
    let finish!: (value: any) => void;
    client.saveDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = provider.writeFile(target, Buffer.from("saved after close"), { create: false, overwrite: true });
    while (!finish) await Promise.resolve();
    provider.forget(target);
    finish({ ...getDraft(), revision: 2, content_revision: 2, body: "saved after close" });
    await expect(saving).resolves.toBeUndefined();
    expect(provider.viewFor(target)).toBeUndefined();
    expect(provider.draftFor(target)).toBeUndefined();
  });
});
