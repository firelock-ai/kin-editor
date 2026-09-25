// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Graph source and durable draft documents share a scheme but have distinct
// identities. Source reads never fall back to files; Save preserves a draft,
// and only explicit Apply publishes through the daemon's guarded mutation.

import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual, TextDecoder } from "util";
import { createEntityDraft, DraftJournal, EntityDraftSession } from "./entity-draft-session";
import type { EntityDraft, DraftApplied } from "./entity-draft-contract";
import * as vscode from "vscode";
import { KinClient } from "./kin-client";
import {
  EntitySourceDocument,
  EntityView,
  lineCommentPrefix,
  truncationBanner,
} from "./graph-entity";
import { GraphFinding } from "./graph-findings";
import { EntityNeighborhood } from "./graph-relations";
import {
  EntityLocator,
  KIN_SCHEME,
  buildEntityUriParts,
  parseEntityUriParts,
} from "./graph-uri";
import { GraphDiagnostics } from "./graph-diagnostics";
import { log, logError } from "./logger";

export type { EntityView } from "./graph-entity";

/** One Kin workspace the viewer can serve entities from. */
export interface ViewerWorkspace {
  key: string;
  workspacePath: string;
  client: KinClient;
}

/**
 * The stable authority for a workspace folder in a `kin://` URI.
 *
 * A digest rather than the folder path, because a URI authority cannot hold a
 * path and a name can collide across a multi-root workspace. It is a pure
 * function of the path, so a tab restored after a window reload still names the
 * same workspace.
 */
export function workspaceKeyFor(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

/** Build the `kin://` URI addressing one entity. */
export function entityUri(locator: EntityLocator): vscode.Uri {
  const parts = buildEntityUriParts(locator);
  return vscode.Uri.from({
    scheme: KIN_SCHEME,
    authority: parts.authority,
    path: parts.path,
    query: parts.query,
  });
}

export const WRITE_PATH_REFUSAL =
  "This is a source or recovery view. Use Kin: Edit Entity to create a durable draft. " +
  "Save preserves draft text; Kin: Apply Saved Draft publishes it. Rename and delete are unavailable here.";

/** A draft UUID remains addressable even when its graph entity was deleted. */
export function draftUri(source: vscode.Uri, draftId: string, revision?: number): vscode.Uri {
  const address = parseEntityUriParts(source);
  if (!address) throw vscode.FileSystemError.FileNotFound(source);
  return vscode.Uri.from({
    scheme: KIN_SCHEME, authority: source.authority, path: source.path,
    query: `id=${encodeURIComponent(address.entityId)}&draft=${draftId}${revision === undefined ? "" : `&revision=${revision}`}`,
  });
}

export class KinEntityFileSystemProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly _onDidChangeFile =
    new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private readonly workspaces = new Map<string, ViewerWorkspace>();
  private readonly views = new Map<string, EntityView>();

  private readonly sessions = new Map<string, EntityDraftSession>();
  private readonly writable = new Set<string>();
  private readonly reads = new Map<string, Promise<EntityView>>();
  private readonly workspaceEpochs = new Map<string, object>();
  private readonly documentEpochs = new Map<string, object>();
  private readonly bindings = new Map<string, object>();
  private readonly retainedDrafts = new Map<string, EntityDraft>();

  constructor(
    private readonly diagnostics: GraphDiagnostics,
    private readonly journal?: DraftJournal,
  ) {}

  /** Register the workspaces whose graphs this provider may serve. */
  setWorkspaces(workspaces: readonly ViewerWorkspace[]): void {
    const next = new Map(workspaces.map(workspace => [workspace.key, workspace]));
    for (const [key, prior] of this.workspaces) {
      const current = next.get(key);
      if (current?.client === prior.client && current.workspacePath === prior.workspacePath) continue;
      this.workspaceEpochs.delete(key);
      for (const document of new Set([...this.views.keys(), ...this.reads.keys()])) {
        if (vscode.Uri.parse(document).authority !== key) continue;
        this.reads.delete(document);
        this.writable.delete(document);
        this.bindings.delete(document);
        if (!this.retainedDrafts.has(document)) this.views.delete(document);
      }
    }
    this.workspaces.clear();
    for (const workspace of workspaces) {
      this.workspaces.set(workspace.key, workspace);
      if (!this.workspaceEpochs.has(workspace.key)) this.workspaceEpochs.set(workspace.key, {});
    }
  }

  availableWorkspaces(): readonly ViewerWorkspace[] { return [...this.workspaces.values()]; }

  /** The cached read for an open document, for the hover to render. */
  viewFor(uri: vscode.Uri): EntityView | undefined {
    return this.views.get(uri.toString());
  }

  /**
   * Forget a closed entity document.
   *
   * Diagnostics live until something removes them, and a user browsing the
   * graph opens a lot of entities. Without this the Problems panel keeps every
   * entity ever opened until the window reloads, which buries the findings for
   * the entity actually in front of them.
   */
  forget(uri: vscode.Uri): void {
    this.documentEpochs.delete(uri.toString());
    this.reads.delete(uri.toString());
    this.bindings.delete(uri.toString());
    this.retainedDrafts.delete(uri.toString());
    this.sessions.delete(uri.toString());
    this.writable.delete(uri.toString());
    if (this.views.delete(uri.toString())) {
      this.diagnostics.clear(uri);
    }
  }

  /**
   * Tell the editor every open entity document changed.
   *
   * Called when the daemon says the graph changed. `stat` answers with a fresh
   * mtime for exactly this reason: a content change the editor cannot see in
   * the stat is a change it will not re-read.
   */
  invalidateAll(): void {
    const events: vscode.FileChangeEvent[] = [];
    for (const key of this.views.keys()) {
      const uri = vscode.Uri.parse(key, true);
      // Neither saved nor dirty draft text is a projection of graph changes.
      if (parseEntityUriParts(uri)?.draftId) continue;
      this.views.delete(key);
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }
    if (events.length > 0) {
      log(`Entity viewer: invalidating ${events.length} open entity document(s)`);
      this._onDidChangeFile.fire(events);
    }
  }

  // ── FileSystemProvider ────────────────────────────────────────────────────

  watch(): vscode.Disposable {
    // Nothing to watch per URI: the graph announces its own changes over MCP and
    // `invalidateAll` fans that out. A watcher that polled the daemon per open
    // document would ask the same question once per tab.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const view = await this.read(uri);
    return {
      type: vscode.FileType.File,
      ctime: view.readAt,
      mtime: view.readAt,
      size: Buffer.byteLength(view.content, "utf8"),
      permissions: this.writable.has(uri.toString()) && this.journal &&
        parseEntityUriParts(uri)?.draftRevision === undefined
        ? undefined : vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const view = await this.read(uri);
    return Buffer.from(view.content, "utf8");
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    // The graph is not a directory tree and this viewer will not pretend it is
    // one. Browsing happens in the graph browser, by name and kind.
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
    const address = parseEntityUriParts(uri);
    if (!address?.draftId || address.draftRevision !== undefined || !this.journal) throw refuseWrite(uri);
    this.workspaceFor(uri);
    // Fatal decoding prevents an invalid byte sequence being acknowledged as
    // replacement characters. Preserve a leading BOM as part of the body.
    let body: string;
    try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
    catch { throw vscode.FileSystemError.Unavailable("Draft text is not valid UTF-8; no Save was sent."); }
    return this.saveDraftFile(uri, body);
  }

  private async saveDraftFile(uri: vscode.Uri, body: string): Promise<void> {
    await this.read(uri);
    const session = this.sessions.get(uri.toString());
    if (!session || !this.writable.has(uri.toString())) throw refuseWrite(uri);
    try {
      const saved = await session.save(body);
      // A close can occur while Save is awaiting its durable acknowledgement.
      // Do not recreate a closed view or misreport that acknowledgement as lost.
      const view = this.views.get(uri.toString());
      if (view && this.sessions.get(uri.toString()) === session) {
        this.retainedDrafts.set(uri.toString(), saved);
        view.content = saved.body;
        view.document.body = saved.body;
        view.readAt = Math.max(Date.now(), view.readAt + 1);
        this.diagnostics.clear(uri);
      }
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(`Draft Save was not acknowledged. Keep this buffer and retry Save to recover the same request. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  draftFor(uri: vscode.Uri): EntityDraft | undefined {
    return this.sessions.get(uri.toString())?.draft;
  }

  async startDraft(uri: vscode.Uri): Promise<vscode.Uri> {
    if (!this.journal) throw refuseWrite(uri);
    const address = parseEntityUriParts(uri);
    if (!address || address.draftId) throw new Error("Open current source before starting another draft. Your existing draft stays available.");
    const workspace = this.workspaceFor(uri);
    const assertCurrent = this.guard(uri, workspace);
    const view = await this.read(uri);
    if (view.document.truncated || !view.document.sourceBase) {
      throw new Error(view.document.sourceBaseRefusal ?? "Editing requires a complete current source read with an editing base. Historical, truncated and older-daemon reads remain available as source views.");
    }
    const capabilities = await workspace.client.draftCapabilities();
    assertCurrent();
    if (!capabilities.durable_save_supported) throw new Error(capabilities.refusal?.message ?? "This daemon cannot durably save drafts on the current storage.");
    const saved = await createEntityDraft(workspace.client, this.journal, uri.toString(), {
      original_source_base: view.document.sourceBase, original_body: view.document.body, body: view.document.body,
    }, assertCurrent);
    assertCurrent();
    const target = draftUri(uri, saved.draft_id);
    // Open through readDraft so reopening and first opening use the same path.
    await this.read(target);
    return target;
  }

  async applyDraft(uri: vscode.Uri, resume = false): Promise<DraftApplied> {
    this.workspaceFor(uri);
    await this.read(uri);
    const session = this.sessions.get(uri.toString());
    if (!session || parseEntityUriParts(uri)?.draftRevision !== undefined) throw refuseWrite(uri);
    return resume ? session.resumeApply() : session.apply();
  }

  currentSourceUri(uri: vscode.Uri): vscode.Uri {
    const address = parseEntityUriParts(uri);
    if (!address) throw vscode.FileSystemError.FileNotFound(uri);
    return vscode.Uri.from({ scheme: KIN_SCHEME, authority: uri.authority, path: uri.path,
      query: `id=${encodeURIComponent(address.entityId)}&read=${randomUUID()}` });
  }

  private workspaceFor(uri: vscode.Uri): ViewerWorkspace {
    const address = parseEntityUriParts(uri);
    if (!address) throw vscode.FileSystemError.FileNotFound(uri);
    const workspace = this.workspaces.get(address.workspaceKey);
    if (!workspace) throw vscode.FileSystemError.Unavailable("This entity belongs to a Kin workspace that is no longer open. Open the folder again to recover its drafts.");
    return workspace;
  }

  delete(uri: vscode.Uri): void {
    throw refuseWrite(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw refuseWrite(oldUri);
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
    this.views.clear();
    this.sessions.clear();
    this.writable.clear();
    this.reads.clear();
    this.workspaceEpochs.clear();
    this.documentEpochs.clear();
    this.bindings.clear();
    this.retainedDrafts.clear();
    this.workspaces.clear();
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * Read one entity, caching the result for the stat/read pair the editor makes.
   *
   * Relations and graph status are read beside the body and are allowed to fail
   * on their own: a body that arrived is still the entity's source, and losing
   * it because a second call timed out would be the worse answer. What the
   * failure must not do is leave the reader thinking the entity has no
   * relations, so the hover says which read did not answer.
   */
  private async read(uri: vscode.Uri): Promise<EntityView> {
    const workspace = this.workspaceFor(uri);
    const key = uri.toString();
    const cached = this.views.get(key);
    if (cached && (!this.retainedDrafts.has(key) || this.bindings.get(key) === this.workspaceEpochs.get(workspace.key))) return cached;

    const inFlight = this.reads.get(uri.toString());
    if (inFlight) return inFlight;
    const reading = cached ? this.rebind(uri, workspace, cached) : this.load(uri);
    this.reads.set(uri.toString(), reading);
    try { return await reading; }
    finally { if (this.reads.get(key) === reading) this.reads.delete(key); }
  }

  private guard(uri: vscode.Uri, workspace: ViewerWorkspace): () => void {
    const key = uri.toString();
    if (!this.documentEpochs.has(key)) this.documentEpochs.set(key, {});
    const document = this.documentEpochs.get(key);
    const epoch = this.workspaceEpochs.get(workspace.key);
    return () => {
      if (this.workspaceEpochs.get(workspace.key) !== epoch ||
          this.workspaces.get(workspace.key)?.client !== workspace.client ||
          this.documentEpochs.get(key) !== document) {
        throw vscode.FileSystemError.Unavailable("This draft's workspace connection or document changed. Keep the buffer and reopen the original workspace before retrying.");
      }
    };
  }

  private async rebind(uri: vscode.Uri, workspace: ViewerWorkspace, view: EntityView): Promise<EntityView> {
    const key = uri.toString();
    const assertCurrent = this.guard(uri, workspace);
    const session = this.sessions.get(key);
    if (session) await session.rebind(workspace.client, assertCurrent);
    else {
      const retained = this.retainedDrafts.get(key)!;
      const current = await workspace.client.readDraft(retained.draft_id, retained.revision);
      if (!isDeepStrictEqual(current, retained)) throw new Error("The reopened workspace does not contain this draft's exact saved identity and revision.");
    }
    let writable = false;
    if (session && parseEntityUriParts(uri)?.draftRevision === undefined) {
      try { writable = (await workspace.client.draftCapabilities()).durable_save_supported; }
      catch (error) { logError("Reopened draft remains readable; Save capability could not be confirmed", error); }
    }
    assertCurrent();
    if (writable) this.writable.add(key);
    this.bindings.set(key, this.workspaceEpochs.get(workspace.key)!);
    return view;
  }

  private async load(uri: vscode.Uri): Promise<EntityView> {
    const address = parseEntityUriParts(uri)!;
    const workspace = this.workspaceFor(uri);
    const assertCurrent = this.guard(uri, workspace);
    if (address.draftId) {
      const draft = await workspace.client.readDraft(address.draftId, address.draftRevision);
      assertCurrent();
      if (draft.scope.entity_id !== address.entityId) throw new Error("Draft entity identity does not match this document.");
      const view: EntityView = {
        document: { entityId: address.entityId, name: address.displayName ?? "Entity draft",
          kind: address.displayKind ?? "Entity", body: draft.body, truncated: false,
          sourceBase: draft.original_source_base, provenance: {} },
        findings: [], content: draft.body, readAt: Date.now(),
      };
      let writable = false;
      if (this.journal && address.draftRevision === undefined) {
        try {
          writable = (await workspace.client.draftCapabilities()).durable_save_supported;
        } catch (error) { logError("Draft remains readable; Save capability could not be confirmed", error); }
      }
      assertCurrent();
      if (this.journal) this.sessions.set(uri.toString(), new EntityDraftSession(
        draft, workspace.client, this.journal, uri.toString(), assertCurrent,
      ));
      if (writable) this.writable.add(uri.toString());
      this.retainedDrafts.set(uri.toString(), draft);
      this.bindings.set(uri.toString(), this.workspaceEpochs.get(workspace.key)!);
      this.views.set(uri.toString(), view);
      this.diagnostics.clear(uri);
      return view;
    }

    let source: Awaited<ReturnType<KinClient["entitySource"]>>;
    try {
      source = await workspace.client.entitySource(address.entityId);
    } catch (err) {
      // The daemon's own words. It distinguishes an id the graph does not hold
      // from a body too large to inline from a graph it could not reach, and
      // every one of those is more useful than "could not open".
      logError(`Entity viewer: get_entity_source failed for ${address.entityId}`, err);
      throw vscode.FileSystemError.Unavailable(
        err instanceof Error ? err.message : String(err)
      );
    }

    assertCurrent();
    const findingLists: GraphFinding[][] = [source.findings];
    let neighborhood: EntityNeighborhood | undefined;
    try {
      const relations = await workspace.client.entityRelations(address.entityId);
      neighborhood = relations.neighborhood;
      findingLists.push(relations.findings);
    } catch (err) {
      logError(
        `Entity viewer: graph_neighborhood failed for ${address.entityId}`,
        err
      );
    }
    assertCurrent();
    try {
      findingLists.push(await workspace.client.graphStatusFindings());
    } catch (err) {
      logError("Entity viewer: kin_graph_status failed", err);
    }

    const view: EntityView = {
      document: source.document,
      neighborhood,
      findings: KinClient.mergeFindings(...findingLists),
      content: renderEntityContent(source.document),
      readAt: Date.now(),
    };
    assertCurrent();
    this.views.set(uri.toString(), view);
    this.diagnostics.publish(uri, view.findings);
    return view;
  }
}

function refuseWrite(uri: vscode.Uri): vscode.FileSystemError {
  return vscode.FileSystemError.NoPermissions(`${WRITE_PATH_REFUSAL} (${uri.path})`);
}

/**
 * The bytes an entity document holds.
 *
 * The body verbatim, plus a banner when and only when the daemon marked it as
 * cut. Nothing else is added: a header would shift every line away from the
 * entity's own numbering, and the name, kind, span and relations belong in the
 * title and the hover where they cannot be mistaken for source.
 */
export function renderEntityContent(document: EntitySourceDocument): string {
  if (!document.truncated) {
    return document.body;
  }
  return `${document.body}\n${truncationBanner(document, lineCommentPrefix(document.language))}\n`;
}
