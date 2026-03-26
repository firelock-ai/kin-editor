// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";
import { KinClient } from "./kin-client";
import { EntityExplorerProvider } from "./entity-explorer";
import { KinStatusBar } from "./status-bar";
import { showSearchQuickPick, showTraceQuickPick } from "./search-panel";

let statusBar: KinStatusBar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspacePath = workspaceFolder.uri.fsPath;
  const kinDir = join(workspacePath, ".kin");
  const config = vscode.workspace.getConfiguration("kin");
  const autoStart = config.get<boolean>("autoStart", true);

  // Only auto-activate if .kin/ exists and autoStart is enabled
  if (!existsSync(kinDir) && autoStart) {
    // Register init command even when not initialized
    context.subscriptions.push(
      vscode.commands.registerCommand("kin.init", async () => {
        const client = new KinClient(workspacePath);
        try {
          await client.init();
          vscode.window.showInformationMessage(
            "Kin repository initialized. Reload window to activate."
          );
        } catch (err) {
          vscode.window.showErrorMessage(`Kin init failed: ${err}`);
        }
      })
    );
    return;
  }

  const client = new KinClient(workspacePath);

  // Entity Explorer tree view
  const explorerProvider = new EntityExplorerProvider(client, workspacePath);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("kinExplorer", explorerProvider)
  );

  // Status bar
  statusBar = new KinStatusBar(client);
  context.subscriptions.push(statusBar);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("kin.search", () =>
      showSearchQuickPick(client, workspacePath)
    ),

    vscode.commands.registerCommand("kin.overview", async () => {
      try {
        const overview = await client.overview();
        const msg = [
          `Entities: ${overview.entities}`,
          `Edges: ${overview.edges}`,
          `Files: ${overview.files}`,
          `Kinds: ${Object.entries(overview.kinds)
            .map(([k, v]) => `${k}(${v})`)
            .join(", ")}`,
        ].join(" | ");
        vscode.window.showInformationMessage(`Kin Overview: ${msg}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Kin overview failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand("kin.trace", () =>
      showTraceQuickPick(client, workspacePath)
    ),

    vscode.commands.registerCommand("kin.init", async () => {
      try {
        await client.init();
        vscode.window.showInformationMessage("Kin repository initialized.");
        explorerProvider.refresh();
        statusBar?.update();
      } catch (err) {
        vscode.window.showErrorMessage(`Kin init failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand("kin.status", async () => {
      try {
        const status = await client.status();
        if (status.initialized) {
          vscode.window.showInformationMessage(
            `Kin: ${status.entityCount} entities, state: ${status.graphState}`
          );
        } else {
          vscode.window.showWarningMessage(
            "Kin is not initialized in this workspace."
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Kin status failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand("kin.refresh", () => {
      explorerProvider.refresh();
      statusBar?.update();
    })
  );
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = undefined;
}
