// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient } from "./kin-client";
import { EntityExplorerProvider } from "./entity-explorer";
import { KinStatusBar } from "./status-bar";
import { KinHoverProvider } from "./providers/hover-provider";
import { KinDefinitionProvider } from "./providers/definition-provider";
import { KinWorkspaceSymbolProvider } from "./providers/symbol-provider";
import { KinReviewProvider } from "./providers/review-provider";
import { KinRenameProvider } from "./providers/rename-provider";
import { showSearchQuickPick, showTraceQuickPick } from "./search-panel";
import { showSetupWorkspace } from "./setup-panel";
import { initLogger, log } from "./logger";
import { WorkspaceManager } from "./workspace-manager";
import {
  describeError,
  formatOverviewMessage,
} from "./accessibility";

let statusBar: KinStatusBar | undefined;
let manager: WorkspaceManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return;
  }

  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);

  log(`Activating Kin extension for ${folders.length} workspace folder(s)`);

  const config = vscode.workspace.getConfiguration("kin");
  const mcpEnabled = config.get<boolean>("mcpEnabled", true);

  manager = new WorkspaceManager(folders, mcpEnabled);
  context.subscriptions.push(manager);

  const setupCwd = (): string | undefined => {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === "file") {
      const owning = vscode.workspace.getWorkspaceFolder(active);
      if (owning) {
        return owning.uri.fsPath;
      }
    }
    return folders[0]?.uri.fsPath;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("kin.setupWorkspace", () =>
      showSetupWorkspace(context, setupCwd())
    )
  );

  // No Kin-initialized folder yet — a fresh machine or a not-yet-indexed
  // workspace. Still register every contributed command so the palette and
  // context menus never answer a first-run user with "command not found":
  // kin.init runs the real initialization, and the query commands guide the
  // user into setup instead of failing. kin.setupWorkspace is registered above
  // and works here too.
  if (manager.size === 0) {
    const initInThisWorkspace = async () => {
      const resolved =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({
              placeHolder: "Select folder to initialize Kin in",
            });
      if (!resolved) return;
      const client = new KinClient(resolved.uri.fsPath);
      try {
        await client.init();
        vscode.window.showInformationMessage(
          "Kin repository initialized. Reload this window to activate the explorer and commands."
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Kin init failed: ${describeError(err)}`);
      }
    };

    const guideToSetup = async () => {
      const choice = await vscode.window.showInformationMessage(
        "Kin isn't initialized in this folder yet. Set it up to enable search, trace, and review.",
        "Set up Kin",
        "Initialize Repository"
      );
      if (choice === "Set up Kin") {
        await vscode.commands.executeCommand("kin.setupWorkspace");
      } else if (choice === "Initialize Repository") {
        await vscode.commands.executeCommand("kin.init");
      }
    };

    context.subscriptions.push(
      vscode.commands.registerCommand("kin.init", initInThisWorkspace),
      ...["kin.search", "kin.overview", "kin.trace", "kin.status", "kin.review", "kin.refresh"].map(
        (id) => vscode.commands.registerCommand(id, guideToSetup)
      )
    );
    return;
  }

  // Connect MCP clients asynchronously — don't block activation
  if (mcpEnabled) {
    manager.connectAll().then(() => {
      log("MCP connections established");
      // Refresh UI now that MCP is live
      explorerProvider.refresh();
      statusBar?.update();
    });

    // Auto-refresh the explorer whenever the daemon re-indexes the graph.
    context.subscriptions.push(
      manager.onGraphChanged(() => {
        log("Graph changed — auto-refreshing entity explorer");
        explorerProvider.refresh();
        statusBar?.update();
      })
    );
  }

  // Use primary client for explorer and status bar
  const primaryClient = manager.primaryClient()!;
  const primaryPath = manager.primaryWorkspacePath()!;

  // Entity Explorer tree view
  const explorerProvider = new EntityExplorerProvider(primaryClient, primaryPath);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("kinExplorer", explorerProvider)
  );

  // Status bar
  statusBar = new KinStatusBar(primaryClient);
  context.subscriptions.push(statusBar);

  // Hover provider — shows entity info on hover for all file types
  const hoverProvider = new KinHoverProvider(manager);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: "file" }, hoverProvider)
  );

  // Definition provider — F12 / Ctrl+Click go-to-definition via kin trace
  const definitionProvider = new KinDefinitionProvider(manager);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { scheme: "file" },
      definitionProvider
    )
  );

  // Workspace symbol provider — Cmd+T / Ctrl+T symbol search via kin search
  const symbolProvider = new KinWorkspaceSymbolProvider(manager);
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider(symbolProvider)
  );

  // Review provider — semantic code review with gutter decorations
  const reviewProvider = new KinReviewProvider(primaryClient);
  context.subscriptions.push(reviewProvider);

  // Rename provider — semantic rename through Kin rename plans
  const renameProvider = new KinRenameProvider(manager);
  context.subscriptions.push(
    vscode.languages.registerRenameProvider({ scheme: "file" }, renameProvider)
  );

  const refreshWorkspaceState = () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const changed = manager!.syncWorkspaceFolders(folders);
    if (!changed) {
      return;
    }

    explorerProvider.refresh();
    statusBar?.update();
    reviewProvider.onActiveEditorChanged(vscode.window.activeTextEditor);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshWorkspaceState();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      reviewProvider.onActiveEditorChanged(editor);
    })
  );

  // Commands — resolve active workspace for multi-root
  context.subscriptions.push(
    vscode.commands.registerCommand("kin.search", async () => {
      const resolved = await manager!.resolveActiveClient();
      if (resolved) {
        await showSearchQuickPick(resolved.client, resolved.workspacePath);
      }
    }),

    vscode.commands.registerCommand("kin.overview", async () => {
      const resolved = await manager!.resolveActiveClient();
      if (!resolved) return;
      try {
        const overview = await resolved.client.overview();
        const msg = formatOverviewMessage(overview);
        vscode.window.showInformationMessage(`Kin Overview: ${msg}`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Kin overview failed: ${describeError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("kin.trace", async () => {
      const resolved = await manager!.resolveActiveClient();
      if (resolved) {
        await showTraceQuickPick(resolved.client, resolved.workspacePath);
      }
    }),

    vscode.commands.registerCommand("kin.init", async () => {
      const resolved = folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: "Select folder to initialize Kin in",
          });
      if (!resolved) return;
      const client = new KinClient(resolved.uri.fsPath);
      try {
        await client.init();
        vscode.window.showInformationMessage(
          "Kin repository initialized. Reload this window to activate the explorer and commands."
        );
        explorerProvider.refresh();
        statusBar?.update();
      } catch (err) {
        vscode.window.showErrorMessage(`Kin init failed: ${describeError(err)}`);
      }
    }),

    vscode.commands.registerCommand("kin.status", async () => {
      const resolved = await manager!.resolveActiveClient();
      if (!resolved) return;
      try {
        const status = await resolved.client.status();
        if (status.initialized) {
          const mcpLabel = resolved.client.isMcpConnected() ? " (MCP)" : " (CLI)";
          vscode.window.showInformationMessage(
            `Kin${mcpLabel}: ${status.entityCount} entities indexed; graph state: ${status.graphState}.`
          );
        } else {
          vscode.window.showWarningMessage(
            "Kin is not initialized in this workspace. Run Kin: Initialize Repository to activate it."
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Kin status failed: ${describeError(err)}`
        );
      }
    }),

    vscode.commands.registerCommand("kin.review", async () => {
      await reviewProvider.reviewFile();
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
  manager?.dispose();
  manager = undefined;
}
