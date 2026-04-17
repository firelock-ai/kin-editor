// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";
import { KinClient } from "./kin-client";
import { McpClient } from "./mcp-client";
import { log } from "./logger";

export interface WorkspaceEntry {
  folder: vscode.WorkspaceFolder;
  client: KinClient;
  mcpClient: McpClient | null;
}

export class WorkspaceManager implements vscode.Disposable {
  private entries: Map<string, WorkspaceEntry> = new Map();
  private readonly mcpEnabled: boolean;

  constructor(folders: readonly vscode.WorkspaceFolder[], mcpEnabled: boolean) {
    this.mcpEnabled = mcpEnabled;
    for (const folder of folders) {
      const kinDir = join(folder.uri.fsPath, ".kin");
      if (existsSync(kinDir)) {
        const mcpClient = this.mcpEnabled ? new McpClient(folder.uri.fsPath) : null;
        const client = new KinClient(folder.uri.fsPath, mcpClient ?? undefined);
        this.entries.set(folder.uri.fsPath, { folder, client, mcpClient });
        log(`Kin-enabled workspace folder: ${folder.name} (mcp: ${mcpEnabled ? "enabled" : "disabled"})`);
      }
    }
  }

  /**
   * Refresh the set of Kin-enabled workspace folders from the current VS Code
   * workspace state. Returns true when the active Kin folder set changed.
   */
  syncWorkspaceFolders(folders: readonly vscode.WorkspaceFolder[]): boolean {
    const nextEntries = new Map<string, WorkspaceEntry>();
    let changed = false;

    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;
      const kinDir = join(folderPath, ".kin");
      const existing = this.entries.get(folderPath);

      if (!existsSync(kinDir)) {
        if (existing) {
          existing.mcpClient?.dispose();
          changed = true;
        }
        continue;
      }

      if (existing) {
        nextEntries.set(folderPath, {
          ...existing,
          folder,
        });
        continue;
      }

      const mcpClient = this.mcpEnabled ? new McpClient(folderPath) : null;
      const client = new KinClient(folderPath, mcpClient ?? undefined);
      nextEntries.set(folderPath, { folder, client, mcpClient });
      changed = true;
      log(`Kin-enabled workspace folder: ${folder.name} (mcp: ${this.mcpEnabled ? "enabled" : "disabled"})`);
    }

    for (const [folderPath, entry] of this.entries.entries()) {
      if (!nextEntries.has(folderPath)) {
        entry.mcpClient?.dispose();
        changed = true;
      }
    }

    this.entries = nextEntries;
    return changed;
  }

  /** Connect all MCP clients. Call after construction. */
  async connectAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.mcpClient) {
        promises.push(entry.mcpClient.connect());
      }
    }
    await Promise.allSettled(promises);
  }

  get size(): number {
    return this.entries.size;
  }

  allEntries(): WorkspaceEntry[] {
    return [...this.entries.values()];
  }

  getClientForPath(filePath: string): KinClient | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(filePath)
    );
    if (folder) {
      return this.entries.get(folder.uri.fsPath)?.client;
    }
    return undefined;
  }

  async resolveActiveClient(): Promise<
    { client: KinClient; workspacePath: string } | undefined
  > {
    // Single entry — no ambiguity
    if (this.entries.size === 1) {
      const entry = this.entries.values().next().value!;
      return { client: entry.client, workspacePath: entry.folder.uri.fsPath };
    }

    // Try active editor
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        const entry = this.entries.get(folder.uri.fsPath);
        if (entry) {
          return {
            client: entry.client,
            workspacePath: entry.folder.uri.fsPath,
          };
        }
      }
    }

    // Prompt user to pick a workspace folder
    if (this.entries.size > 1) {
      const items = this.allEntries().map((e) => ({
        label: e.folder.name,
        description: e.folder.uri.fsPath,
        entry: e,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a Kin workspace",
      });
      if (picked) {
        return {
          client: picked.entry.client,
          workspacePath: picked.entry.folder.uri.fsPath,
        };
      }
    }

    return undefined;
  }

  primaryClient(): KinClient | undefined {
    const first = this.entries.values().next().value;
    return first?.client;
  }

  primaryWorkspacePath(): string | undefined {
    const first = this.entries.values().next().value;
    return first?.folder.uri.fsPath;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.mcpClient) {
        entry.mcpClient.dispose();
      }
    }
    this.entries.clear();
  }
}
