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
