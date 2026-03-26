// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { existsSync } from "fs";
import { join, basename } from "path";
import { KinClient } from "./kin-client";
import { log } from "./logger";

export interface WorkspaceEntry {
  folder: vscode.WorkspaceFolder;
  client: KinClient;
}

export class WorkspaceManager {
  private entries: Map<string, WorkspaceEntry> = new Map();

  constructor(folders: readonly vscode.WorkspaceFolder[]) {
    for (const folder of folders) {
      const kinDir = join(folder.uri.fsPath, ".kin");
      if (existsSync(kinDir)) {
        const client = new KinClient(folder.uri.fsPath);
        this.entries.set(folder.uri.fsPath, { folder, client });
        log(`Kin-enabled workspace folder: ${folder.name}`);
      }
    }
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

  /**
   * Returns the first available client (for status bar / fallback).
   */
  primaryClient(): KinClient | undefined {
    const first = this.entries.values().next().value;
    return first?.client;
  }

  primaryWorkspacePath(): string | undefined {
    const first = this.entries.values().next().value;
    return first?.folder.uri.fsPath;
  }
}
