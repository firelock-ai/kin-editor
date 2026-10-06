// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

const outputChannel = {
  clear: jest.fn(),
  show: jest.fn(),
  appendLine: jest.fn(),
  dispose: jest.fn(),
};

const diagnostics = {
  set: jest.fn(),
  clear: jest.fn(),
  dispose: jest.fn(),
};

jest.mock(
  "vscode",
  () => {
    class Position {
      constructor(
        public line: number,
        public character: number
      ) {}
    }

    class Range {
      constructor(
        public start: Position,
        public end: Position
      ) {}
    }

    class MarkdownString {
      constructor(public value: string) {}
    }

    return {
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
      DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
      },
      Diagnostic: class Diagnostic {
        public source?: string;
        public code?: string;

        constructor(
          public range: Range,
          public message: string,
          public severity: number
        ) {}
      },
      Position,
      Range,
      MarkdownString,
      ThemeColor: class ThemeColor {},
      OverviewRulerLane: {
        Right: 1,
      },
      window: {
        activeTextEditor: undefined,
        createOutputChannel: jest.fn(() => outputChannel),
        createTextEditorDecorationType: jest.fn(() => ({ dispose: jest.fn() })),
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
      },
      languages: {
        createDiagnosticCollection: jest.fn(() => diagnostics),
      },
    };
  },
  { virtual: true }
);

import * as vscode from "vscode";
import { KinReviewProvider } from "../providers/review-provider";

describe("KinReviewProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.window as any).activeTextEditor = undefined;
  });

  it.each([
    { enrichment: { status: "bounded", scope: "committed_graph", selected_change: "old", limitation: "The selected revision has unsettled calls." } },
    { verdict: { state: "inconclusive", limiting_factor: "caller coverage is unproven" } },
    { enrichment: { status: "bounded", limitation: "Recorded debt still bounds this review." }, verdict: { state: "certified" } },
  ])("qualifies empty findings using the recorded limits: %j", async (disclosure) => {
    const client = { review: jest.fn().mockResolvedValue({
      file: "src/a.ts", findings: [], summary: "0 findings", ...disclosure,
    }) };
    await new KinReviewProvider(client as never).reviewFile("/workspace/src/a.ts");
    const lines = outputChannel.appendLine.mock.calls.map(([line]) => line);
    const limitation = disclosure.enrichment?.limitation ?? disclosure.verdict?.limiting_factor;
    expect(lines).toContain(`not settled: ${limitation}`);
    expect(lines.indexOf(`not settled: ${limitation}`)).toBeLessThan(
      lines.indexOf("No findings detected; not settled.")
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      `Kin Review: not settled. ${limitation}`
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(diagnostics.clear).toHaveBeenCalled();
  });

  it.each(["inconclusive", "certified"])("keeps an unverified proof context bounded beside a %s verdict", async (state) => {
    const client = { review: jest.fn().mockResolvedValue({
      file: "old.ts", findings: [], summary: "0 findings", envelopeVersion: 2,
      verdict: { state, limiting_factor: "proof_context_unverified" },
    }) };
    await new KinReviewProvider(client as never).reviewFile("/workspace/old.ts");
    const lines = outputChannel.appendLine.mock.calls.map(([line]) => line);
    const limitation = lines.find((line) => line.startsWith("not settled:"));
    expect(limitation).toContain("selected graph has no verified call-site proof context");
    expect(limitation).toContain("missing references are not proof of absence");
    expect(limitation).not.toMatch(/proof_context_unverified|Unknown Kin diagnostic|sweep/);
    expect(lines.indexOf(limitation)).toBeLessThan(lines.indexOf("No findings detected; not settled."));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("not settled"));
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { enrichment: { status: "no_recorded_call_site_debt" } },
    { verdict: { state: "future-state" } },
    { verdict: { state: "conclusive" } },
  ])("does not infer complete analysis from legacy or unknown metadata: %j", async (disclosure) => {
    const client = { review: jest.fn().mockResolvedValue({
      file: "src/a.ts", findings: [], summary: "0 findings", ...disclosure,
    }) };
    await new KinReviewProvider(client as never).reviewFile("/workspace/src/a.ts");
    expect(outputChannel.appendLine).toHaveBeenCalledWith("No findings detected; completeness unavailable.");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("completeness unavailable")
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("keeps the no-findings message when the daemon explicitly certifies the review", async () => {
    const client = { review: jest.fn().mockResolvedValue({
      file: "src/a.ts", findings: [], summary: "0 findings",
      enrichment: { status: "no_recorded_call_site_debt" },
      verdict: { state: "certified" },
    }) };
    await new KinReviewProvider(client as never).reviewFile("/workspace/src/a.ts");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Kin Review: no findings.");
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("clears stale decorations on active editor change and restores them when returning", async () => {
    const editorA = {
      document: { uri: { fsPath: "/workspace/src/a.ts" } },
      setDecorations: jest.fn(),
    } as unknown as vscode.TextEditor;
    const editorB = {
      document: { uri: { fsPath: "/workspace/src/b.ts" } },
      setDecorations: jest.fn(),
    } as unknown as vscode.TextEditor;

    (vscode.window as any).activeTextEditor = editorA;

    const client = {
      review: jest.fn().mockResolvedValue({
        file: "/workspace/src/a.ts",
        summary: "ok",
        findings: [
          {
            entity: "foo",
            kind: "Function",
            file: "/workspace/src/a.ts",
            line: 3,
            severity: "warning",
            message: "check this",
          },
        ],
      }),
    };

    const provider = new KinReviewProvider(client as never);
    await provider.reviewFile();

    expect(editorA.setDecorations).toHaveBeenCalled();
    const editorAMock = editorA.setDecorations as unknown as jest.Mock;
    const beforeSwitchCalls = editorAMock.mock.calls.length;

    provider.onActiveEditorChanged(editorB);
    expect(editorAMock.mock.calls.length).toBeGreaterThan(beforeSwitchCalls);
    expect(editorAMock).toHaveBeenCalledWith(expect.anything(), []);

    provider.onActiveEditorChanged(editorA);
    expect(editorAMock.mock.calls.length).toBeGreaterThan(beforeSwitchCalls + 3);
  });
});
