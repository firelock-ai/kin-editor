// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// The `kin://` entity viewer: a read-only FileSystemProvider that opens a graph
// entity as a document.
//
// The document's bytes are the entity's body as the graph served it, and
// nothing else. No file is opened, no span is re-derived from disk, and when
// the graph cannot answer the viewer refuses and says which part could not,
// because a viewer that silently read the file would be indistinguishable from
// a working one while showing something graph truth never served.
//
// Writing is refused by the provider, not merely hidden by the UI. The founder's
// ruling of 2026-09-11 is viewer plus diagnostics first and the `kin://` write
// path after the entity-shaped write tool exists, so the refusal names that
// rather than pretending the surface is inherently read-only.

import { createHash } from "crypto";
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

/**
 * The sentence every write path answers with.
 *
 * One constant because a user who tries to save, rename and delete should read
 * the same reason three times rather than three different guesses at it.
 */
export const WRITE_PATH_REFUSAL =
  "Kin entity documents are read-only for now. Editing one has to go through an entity-shaped write to the " +
  "graph, which projects the new body back into the working file; that tool is being built and the viewer " +
  "will accept saves once it exists. Edit the projected file in the meantime.";

export class KinEntityFileSystemProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private readonly _onDidChangeFile =
    new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private readonly workspaces = new Map<string, ViewerWorkspace>();
  private readonly views = new Map<string, EntityView>();

  constructor(private readonly diagnostics: GraphDiagnostics) {}

  /** Register the workspaces whose graphs this provider may serve. */
  setWorkspaces(workspaces: readonly ViewerWorkspace[]): void {
    this.workspaces.clear();
    for (const workspace of workspaces) {
      this.workspaces.set(workspace.key, workspace);
    }
  }

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
      permissions: vscode.FilePermission.Readonly,
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

  writeFile(uri: vscode.Uri): void {
    throw refuseWrite(uri);
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
    const cached = this.views.get(uri.toString());
    if (cached) {
      return cached;
    }

    const address = parseEntityUriParts({
      authority: uri.authority,
      path: uri.path,
      query: uri.query,
    });
    if (!address) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const workspace = this.workspaces.get(address.workspaceKey);
    if (!workspace) {
      throw vscode.FileSystemError.Unavailable(
        `This entity belongs to a Kin workspace that is no longer open. Open the folder again and reopen the entity.`
      );
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
