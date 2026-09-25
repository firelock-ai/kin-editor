// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { activate } from "../extension";
import { InitOutcome, runKinInit } from "../first-run";
import { log, showLog } from "../logger";

jest.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ name: "fixture", uri: { fsPath: "/fixture" } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  window: {
    registerTreeDataProvider: jest.fn(() => ({ dispose: jest.fn() })),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    withProgress: jest.fn((_options, run) => run({ report: jest.fn() })),
  },
  commands: {
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    executeCommand: jest.fn().mockResolvedValue(undefined),
  },
  ProgressLocation: { Notification: 15 },
  SymbolKind: {},
}), { virtual: true });
jest.mock("../workspace-manager", () => ({
  WorkspaceManager: jest.fn(() => ({ size: 0, dispose: jest.fn() })),
}));
jest.mock("../logger", () => ({
  initLogger: jest.fn(() => ({ dispose: jest.fn() })),
  log: jest.fn(), logError: jest.fn(), showLog: jest.fn(),
}));
jest.mock("../setup-health", () => ({
  ...jest.requireActual("../setup-health"),
  resolveKinBinary: () => "/managed/kin",
}));
jest.mock("../first-run", () => ({
  ...jest.requireActual("../first-run"),
  runKinInit: jest.fn(),
}));

const mockRunInit = jest.mocked(runKinInit);
const mockExecute = jest.mocked(vscode.commands.executeCommand);

function registerInit(): () => Promise<boolean> {
  activate({
    subscriptions: [],
    globalState: { get: () => true },
  } as unknown as vscode.ExtensionContext);
  const command = jest.mocked(vscode.commands.registerCommand).mock.calls
    .find(([id]) => id === "kin.init");
  expect(command).toBeDefined();
  return command![1] as () => Promise<boolean>;
}

function serve(outcome: InitOutcome): void {
  mockRunInit.mockImplementation(async (_binary, _cwd, onLine) => {
    outcome.lines.forEach(onLine);
    return outcome;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
  jest.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
  jest.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined);
});

describe("registered kin.init command", () => {
  it.each([0, 7, 8])("activates the admitted graph for exit %i and offers reload", async (exitCode) => {
    const explanation = exitCode === 7 ? "Enrichment ended before it could be attested."
      : exitCode === 8 ? "Graph-section materialization did not complete: disk is full."
      : "Repository authority verified.";
    serve({ ok: exitCode === 0, exitCode, signal: null,
      lines: [{ stream: "stderr", text: explanation }] });
    const notice = exitCode === 0 ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    jest.mocked(notice).mockResolvedValue("Reload Window" as never);

    expect(await registerInit()()).toBe(true);
    expect(mockRunInit).toHaveBeenCalledWith("/managed/kin", "/fixture", expect.any(Function));
    expect(log).toHaveBeenCalledWith(`kin init [stderr] ${explanation}`);
    expect(mockExecute).toHaveBeenCalledWith("setContext", "kin.initialized", true);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(explanation), "Reload Window", "Show output");
    expect(mockExecute).toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    if (exitCode !== 0) {
      expect(notice).toHaveBeenCalledWith(expect.stringContaining(`caveat (exit ${exitCode})`), "Reload Window", "Show output");
      expect(notice).toHaveBeenCalledWith(expect.stringContaining(exitCode === 7 ? "kin doctor" : "kin graph materialize"), "Reload Window", "Show output");
    }
  });

  it.each([
    { exitCode: 1, signal: null },
    { exitCode: 3, signal: null },
    { exitCode: 9, signal: null },
    { exitCode: null, signal: "SIGKILL" },
    { exitCode: 7, signal: "SIGTERM" },
    { exitCode: 8, signal: "SIGTERM" },
  ])("does not activate or reload after $exitCode / $signal", async ({ exitCode, signal }) => {
    serve({ ok: false, exitCode, signal,
      lines: [{ stream: "stderr", text: "The CLI's exact failure explanation." }] });
    jest.mocked(vscode.window.showErrorMessage).mockResolvedValue("Show output" as never);
    expect(await registerInit()()).toBe(false);
    expect(mockExecute).not.toHaveBeenCalledWith("setContext", "kin.initialized", true);
    expect(mockExecute).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("The CLI's exact failure explanation."), "Show output");
    expect(showLog).toHaveBeenCalled();
  });

  it("keeps admission and exposes complete output when a caveat is inspected", async () => {
    serve({ ok: false, exitCode: 7, signal: null, lines: [] });
    jest.mocked(vscode.window.showWarningMessage).mockResolvedValue("Show output" as never);
    expect(await registerInit()()).toBe(true);
    expect(showLog).toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledWith("setContext", "kin.initialized", true);
    expect(mockExecute).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("CLI printed no explanation"), "Reload Window", "Show output");
  });
});
