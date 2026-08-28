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
  formatContractDriftMessage,
  formatOverviewMessage,
} from "./accessibility";

let statusBar: KinStatusBar | undefined;
let manager: WorkspaceManager | undefined;

/** Every command declared in contributes.commands. */
const CONTRIBUTED_COMMANDS = [
  "kin.setupWorkspace",
  "kin.search",
  "kin.overview",
  "kin.trace",
  "kin.init",
  "kin.status",
  "kin.review",
  "kin.refresh",
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    // The palette lists every contributed command from the manifest as soon as
    // the extension activates, and activation is onStartupFinished. With no
    // folder open there is nothing to bind them to, so bind them to an answer
    // rather than letting the palette report "command not found".
    context.subscriptions.push(
      ...CONTRIBUTED_COMMANDS.map((id) =>
        vscode.commands.registerCommand(id, () => explainNoFolder())
      )
    );
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

  // Every Kin folder can be removed from the workspace after activation. When
  // that happens there is no client left to resolve, and a command that simply
  // returns leaves the user with no answer at all. Say what happened instead.
  const resolveClientOrExplain = async () => {
    if (manager!.size === 0) {
      vscode.window.showWarningMessage(
        "No Kin-initialized folder is open. Open a folder that contains .kin/, or run Kin: Initialize Repository."
      );
      return undefined;
    }
    return manager!.resolveActiveClient();
  };

  // Commands — resolve active workspace for multi-root
  context.subscriptions.push(
    vscode.commands.registerCommand("kin.search", async () => {
      const resolved = await resolveClientOrExplain();
      if (resolved) {
        await showSearchQuickPick(resolved.client, resolved.workspacePath);
      }
    }),

    vscode.commands.registerCommand("kin.overview", async () => {
      const resolved = await resolveClientOrExplain();
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
      const resolved = await resolveClientOrExplain();
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
      const resolved = await resolveClientOrExplain();
      if (!resolved) return;
      try {
        const status = await resolved.client.status();
        if (status.contractDrift) {
          vscode.window.showWarningMessage(
            formatContractDriftMessage(status.contractDrift)
          );
        } else if (status.reachable === false) {
          vscode.window.showErrorMessage(
            "Kin could not be reached in this workspace. Check that the kin binary is installed and the daemon can start, then run Kin: Show Status again."
          );
        } else if (status.initialized) {
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
      // Review the file through the client that owns it. Falling back to the
      // primary client would make the reviewed path relative to the wrong
      // repository in a multi-root workspace.
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      const owning = active ? manager!.getClientForPath(active) : undefined;
      await reviewProvider.reviewFile(undefined, owning);
    }),

    vscode.commands.registerCommand("kin.refresh", () => {
      explorerProvider.refresh();
      statusBar?.update();
    })
  );
}

/**
 * Answer a Kin command invoked from a window that had no folder open when the
 * extension activated. Re-reads the live workspace so a folder opened since
 * activation gets the reload it needs instead of a stale complaint.
 */
async function explainNoFolder(): Promise<void> {
  const current = vscode.workspace.workspaceFolders;
  if (current && current.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      "Kin started before this folder was open. Reload the window to enable Kin here.",
      "Reload Window"
    );
    if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return;
  }
  await vscode.window.showInformationMessage(
    "Kin needs an open folder. Open the repository you want to work in, then run this command again."
  );
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = undefined;
  manager?.dispose();
  manager = undefined;
}
