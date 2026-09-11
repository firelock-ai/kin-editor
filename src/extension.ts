// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { EntityExplorerProvider } from "./entity-explorer";
import { GraphBrowserProvider } from "./graph-browser";
import { GraphDiagnostics } from "./graph-diagnostics";
import {
  KinEntityFileSystemProvider,
  entityUri,
  workspaceKeyFor,
} from "./entity-viewer";
import { KinEntityHoverProvider } from "./providers/entity-hover-provider";
import { KinStatusBar } from "./status-bar";
import { KinHoverProvider } from "./providers/hover-provider";
import { KinDefinitionProvider } from "./providers/definition-provider";
import { KinWorkspaceSymbolProvider } from "./providers/symbol-provider";
import { KinReviewProvider } from "./providers/review-provider";
import { KinRenameProvider } from "./providers/rename-provider";
import { showSearchQuickPick, showTraceQuickPick } from "./search-panel";
import { showSetupWorkspace } from "./setup-panel";
import { resolveKinBinary } from "./setup-health";
import {
  CONTEXT_INITIALIZED,
  FIRST_RUN_ACTION,
  FIRST_RUN_DISMISS,
  FIRST_RUN_OFFER,
  FIRST_RUN_OFFERED_KEY,
  InitOutcome,
  runKinInit,
  shouldOfferFirstRun,
  summarizeInit,
  walkthroughTarget,
} from "./first-run";
import { initLogger, log, showLog } from "./logger";
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
  "kin.openWalkthrough",
  "kin.openEntity",
] as const;

/**
 * The install command the walkthrough and the no-binary error both offer.
 *
 * One constant rather than two copies, because a stale install line in a
 * first-run surface is worse than none: it is the first thing a stranger
 * types.
 */
const INSTALL_COMMAND = "curl -fsSL https://get.kinlab.dev/install | sh";

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;

  // Registered before every branch below, because it is the one command that
  // answers when there is nothing yet to answer about. A window with no folder
  // and a folder with no graph both reach the walkthrough from here.
  context.subscriptions.push(
    vscode.commands.registerCommand("kin.openWalkthrough", () =>
      openWalkthrough(context)
    )
  );

  if (!folders || folders.length === 0) {
    void setInitialized(false);
    // The palette lists every contributed command from the manifest as soon as
    // the extension activates, and activation is onStartupFinished. With no
    // folder open there is nothing to bind them to, so bind them to an answer
    // rather than letting the palette report "command not found".
    context.subscriptions.push(
      ...CONTRIBUTED_COMMANDS.filter((id) => id !== "kin.openWalkthrough").map(
        (id) => vscode.commands.registerCommand(id, () => explainNoFolder())
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
  void setInitialized(manager.size > 0);

  if (manager.size === 0) {
    // The Entity Explorer has no client to list entities from here, so it is
    // registered with a provider that returns nothing. That makes the view
    // empty on purpose rather than by omission, which is what the manifest's
    // viewsWelcome block renders into: the coldwalk found an empty panel with
    // no explanation and no next step, and this is the panel it found.
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider("kinExplorer", EMPTY_EXPLORER),
      // Both views are contributed, and which one is visible is decided by the
      // kin.entityViewer setting's `when` clause rather than by this branch. A
      // contributed view with no registered provider renders an error where the
      // welcome content should be, so the empty one is registered for both.
      vscode.window.registerTreeDataProvider("kinGraph", EMPTY_EXPLORER)
    );

    const guideToSetup = async () => {
      const choice = await vscode.window.showInformationMessage(
        "This folder has no Kin graph yet. Build one to enable search, trace and review.",
        "Start here",
        "Build the graph"
      );
      if (choice === "Start here") {
        await vscode.commands.executeCommand("kin.openWalkthrough");
      } else if (choice === "Build the graph") {
        await vscode.commands.executeCommand("kin.init");
      }
    };

    context.subscriptions.push(
      vscode.commands.registerCommand("kin.init", () => initGraph(folders)),
      ...[
        "kin.search",
        "kin.overview",
        "kin.trace",
        "kin.status",
        "kin.review",
        "kin.refresh",
        "kin.openEntity",
      ].map((id) => vscode.commands.registerCommand(id, guideToSetup))
    );

    void offerFirstRun(context, {
      hasWorkspaceFolder: true,
      kinFolderCount: manager.size,
      alreadyOffered: context.globalState.get<boolean>(FIRST_RUN_OFFERED_KEY, false),
    });
    return;
  }

  // Connect MCP clients asynchronously — don't block activation
  if (mcpEnabled) {
    manager.connectAll().then(() => {
      log("MCP connections established");
      // Refresh UI now that MCP is live
      refreshTrees();
      statusBar?.update();
    });

    // Auto-refresh the trees whenever the daemon re-indexes the graph, and tell
    // the editor every open kin:// document changed. Without the second half an
    // open entity keeps showing the body it was opened with, which after a
    // re-index is a body the graph no longer holds.
    context.subscriptions.push(
      manager.onGraphChanged(() => {
        log("Graph changed — auto-refreshing the entity trees and open entity documents");
        refreshTrees();
        entityProvider?.invalidateAll();
        statusBar?.update();
      })
    );
  }

  // Use primary client for explorer and status bar
  const primaryClient = manager.primaryClient()!;
  const primaryPath = manager.primaryWorkspacePath()!;

  // Entity Explorer tree view. Both trees are registered and the kin.entityViewer
  // setting's `when` clause decides which one the sidebar shows, so turning the
  // viewer off puts the old explorer back with no reload and no second code path.
  const explorerProvider = new EntityExplorerProvider(primaryClient, primaryPath);
  const browserProvider = new GraphBrowserProvider(
    primaryClient,
    workspaceKeyFor(primaryPath)
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("kinExplorer", explorerProvider),
    vscode.window.registerTreeDataProvider("kinGraph", browserProvider)
  );

  // The kin:// entity viewer. Registered only when the setting is on, so the
  // scheme is genuinely inert rather than answering with a hidden feature.
  const entityViewerEnabled = config.get<boolean>("entityViewer", true);
  let entityProvider: KinEntityFileSystemProvider | undefined;
  if (entityViewerEnabled) {
    const diagnostics = new GraphDiagnostics();
    entityProvider = new KinEntityFileSystemProvider(diagnostics);
    entityProvider.setWorkspaces(viewerWorkspaces(manager));
    context.subscriptions.push(
      diagnostics,
      entityProvider,
      vscode.workspace.registerFileSystemProvider("kin", entityProvider, {
        isCaseSensitive: true,
        isReadonly: true,
      }),
      vscode.languages.registerHoverProvider(
        { scheme: "kin" },
        new KinEntityHoverProvider(entityProvider)
      )
    );
    log("Entity viewer enabled: kin:// documents, graph browser and graph diagnostics");
  }

  const refreshTrees = () => {
    explorerProvider.refresh();
    browserProvider.refresh();
  };

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

    refreshTrees();
    // The viewer serves documents out of whichever clients are live now. A
    // folder that has been removed must stop answering rather than keep serving
    // from a disposed client.
    entityProvider?.setWorkspaces(viewerWorkspaces(manager!));
    entityProvider?.invalidateAll();
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
      const built = await initGraph(folders);
      if (built) {
        refreshTrees();
        statusBar?.update();
      }
    }),

    // The command id and the `registerCommand(` call stay on one line: the
    // contributions guard reads the source for that exact pair, and a wrapped
    // argument list is a registration it cannot see.
    vscode.commands.registerCommand("kin.openEntity", async (target?: OpenEntityTarget) => {
      if (!entityViewerEnabled) {
        vscode.window.showInformationMessage(
          "Kin entity documents are turned off. Switch on kin.entityViewer in settings to open entities from the graph."
        );
        return;
      }
      await openEntityDocument(manager!, target);
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
      refreshTrees();
      entityProvider?.invalidateAll();
      statusBar?.update();
    })
  );
}

/** What `kin.openEntity` is handed when a graph browser row is clicked. */
interface OpenEntityTarget {
  entity: {
    id?: string;
    name: string;
    kind: string;
    language?: string;
  };
  workspaceKey: string;
}

/** The workspaces the entity viewer may serve, keyed the way a URI addresses them. */
function viewerWorkspaces(manager: WorkspaceManager) {
  return manager.allEntries().map((entry) => ({
    key: workspaceKeyFor(entry.folder.uri.fsPath),
    workspacePath: entry.folder.uri.fsPath,
    client: entry.client,
  }));
}

/**
 * Open one entity as a `kin://` document.
 *
 * Invoked from a graph browser row with the entity it holds, and from the
 * palette with nothing, where it asks the graph for candidates by name. The
 * palette path goes through `search`, which is the semantic query, so a user
 * who types what a function does reaches the entity without knowing its name.
 */
async function openEntityDocument(
  manager: WorkspaceManager,
  target?: OpenEntityTarget
): Promise<void> {
  let resolved = target;

  if (!resolved) {
    const active = await manager.resolveActiveClient();
    if (!active) {
      vscode.window.showWarningMessage(
        "No Kin-initialized folder is open, so there is no graph to open an entity from."
      );
      return;
    }
    const query = await vscode.window.showInputBox({
      prompt: "Open an entity from the Kin graph",
      placeHolder: "Describe it, or type its name: e.g. 'retry logic', 'KinClient'",
    });
    if (!query) {
      return;
    }
    let results;
    try {
      results = await active.client.search(query);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Kin could not search the graph: ${describeError(err)}`
      );
      return;
    }
    if (results.length === 0) {
      vscode.window.showInformationMessage(
        `Kin: the graph returned no entities for "${query}".`
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      results.map((entity) => ({
        label: entity.name,
        description: entity.kind,
        detail: entity.signature,
        entity,
      })),
      { placeHolder: `${results.length} entities for "${query}"`, matchOnDescription: true }
    );
    if (!picked) {
      return;
    }
    resolved = {
      entity: picked.entity,
      workspaceKey: workspaceKeyFor(active.workspacePath),
    };
  }

  if (!resolved.entity.id) {
    // An entity with no graph id cannot be addressed, and the alternative is
    // guessing one from its name. Say which answer was short rather than
    // opening something that might be a different entity of the same name.
    vscode.window.showWarningMessage(
      `Kin returned no graph id for ${resolved.entity.name}, so it cannot be opened as a graph document. ` +
        `Update the kin CLI, which publishes entity ids on its search answers.`
    );
    return;
  }

  const uri = entityUri({
    workspaceKey: resolved.workspaceKey,
    entityId: resolved.entity.id,
    kind: resolved.entity.kind,
    name: resolved.entity.name,
    language: resolved.entity.language,
  });
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Kin could not open ${resolved.entity.name}: ${describeError(err)}`
    );
  }
}

/**
 * A tree provider with nothing in it, for the view a workspace with no graph
 * shows. It exists so the view is empty by declaration, and so the welcome
 * content contributed for that case has a registered view to render into.
 */
const EMPTY_EXPLORER: vscode.TreeDataProvider<never> = {
  getChildren: () => [],
  getTreeItem: (element: never) => element,
};

/**
 * Publish whether this workspace has a Kin graph, for the `when` clauses in
 * contributes.viewsWelcome.
 *
 * The key is only ever set from what the workspace manager found, never from
 * an assumption, so the welcome block cannot claim a state the extension did
 * not observe.
 */
async function setInitialized(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", CONTEXT_INITIALIZED, value);
}

/** Open the first-run walkthrough, addressed through the live extension id. */
async function openWalkthrough(
  context: vscode.ExtensionContext
): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openWalkthrough",
    walkthroughTarget(context.extension.id),
    false
  );
}

/**
 * Make the one-time first-run offer, once the decision says to.
 *
 * The flag is written before the notification is shown rather than after the
 * user answers it, because an unanswered notification is dismissed silently
 * and a flag written on the answer would re-offer forever.
 */
async function offerFirstRun(
  context: vscode.ExtensionContext,
  state: Parameters<typeof shouldOfferFirstRun>[0]
): Promise<void> {
  if (!shouldOfferFirstRun(state)) {
    return;
  }
  await context.globalState.update(FIRST_RUN_OFFERED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    FIRST_RUN_OFFER,
    FIRST_RUN_ACTION,
    FIRST_RUN_DISMISS
  );
  if (choice === FIRST_RUN_ACTION) {
    await vscode.commands.executeCommand("kin.openWalkthrough");
  }
}

/**
 * Run `kin init` in a chosen folder and report what the CLI said.
 *
 * The one place the extension builds a graph, so the streaming, the refusal
 * text and the missing-binary case are written once. Everything the user reads
 * on the failing path is the CLI's own last line, quoted; this function has no
 * opinion about why an init refused and does not invent one.
 *
 * Returns true only when the CLI exited zero.
 */
async function initGraph(
  folders: readonly vscode.WorkspaceFolder[]
): Promise<boolean> {
  const resolved =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({
          placeHolder: "Select the folder to build the Kin graph in",
        });
  if (!resolved) return false;

  const binary = resolveKinBinary();
  let outcome: InitOutcome;
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Kin: building the graph",
        cancellable: false,
      },
      (progress) =>
        runKinInit(binary, resolved.uri.fsPath, (line) => {
          log(`kin init [${line.stream}] ${line.text}`);
          const trimmed = line.text.trim();
          if (trimmed.length > 0) {
            progress.report({ message: trimmed });
          }
        })
    );
  } catch (err) {
    await reportInitCouldNotStart(binary, err);
    return false;
  }

  const summary = summarizeInit(outcome);
  if (summary.tone === "error") {
    const choice = await vscode.window.showErrorMessage(
      summary.message,
      "Show output"
    );
    if (choice === "Show output") {
      showLog();
    }
    return false;
  }

  await setInitialized(true);
  const choice = await vscode.window.showInformationMessage(
    `${summary.message} Reload the window to activate the explorer and the query commands.`,
    "Reload Window",
    "Show output"
  );
  if (choice === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } else if (choice === "Show output") {
    showLog();
  }
  return true;
}

/** The `kin init` process never started. Say which case this is. */
async function reportInitCouldNotStart(
  binary: string,
  err: unknown
): Promise<void> {
  if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
    vscode.window.showErrorMessage(
      `Kin init could not start: ${describeError(err)}`
    );
    return;
  }
  const choice = await vscode.window.showErrorMessage(
    `No kin binary was found at "${binary}". Install Kin, or set kin.binaryPath in settings.`,
    "Copy install command"
  );
  if (choice === "Copy install command") {
    await vscode.env.clipboard.writeText(INSTALL_COMMAND);
    vscode.window.showInformationMessage(
      `Copied: ${INSTALL_COMMAND}`
    );
  }
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
