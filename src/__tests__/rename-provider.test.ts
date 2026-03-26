// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

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

    class WorkspaceEdit {
      public edits: Array<{
        uri: { fsPath: string };
        range: Range;
        text: string;
      }> = [];

      replace(uri: { fsPath: string }, range: Range, text: string) {
        this.edits.push({ uri, range, text });
      }
    }

    return {
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
      Position,
      Range,
      WorkspaceEdit,
      workspace: {
        openTextDocument: jest.fn(),
      },
      window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
      },
    };
  },
  { virtual: true }
);

import * as vscode from "vscode";
import { KinRenameProvider } from "../providers/rename-provider";
import { WorkspaceManager } from "../workspace-manager";

describe("KinRenameProvider", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("maps explicit rename plan edits into a WorkspaceEdit", async () => {
    const client = {
      getWorkspacePath: () => "/workspace",
      renamePlan: jest.fn().mockResolvedValue({
        entity: { name: "oldName", kind: "Function", file: "src/demo.ts", line: 3 },
        newName: "newName",
        edits: [
          {
            file: "src/demo.ts",
            startLine: 3,
            startCol: 9,
            endLine: 3,
            endCol: 16,
            replacement: "newName",
          },
        ],
        warnings: [],
      }),
    };
    const manager = {
      getClientForPath: jest.fn(() => client),
    } as unknown as WorkspaceManager;

    const provider = new KinRenameProvider(manager);
    const document = {
      uri: { fsPath: "/workspace/src/demo.ts" },
      getWordRangeAtPosition: () => new vscode.Range(new vscode.Position(2, 9), new vscode.Position(2, 16)),
      getText: () => "oldName",
    } as any;

    const edit = await provider.provideRenameEdits(
      document,
      new vscode.Position(2, 12),
      "newName",
      {} as any
    );

    expect(client.renamePlan).toHaveBeenCalledWith(
      "oldName",
      "newName",
      "/workspace/src/demo.ts",
      3
    );
    expect(edit).toBeInstanceOf(vscode.WorkspaceEdit);
    expect((edit as any).edits).toEqual([
      {
        uri: { fsPath: "/workspace/src/demo.ts" },
        range: new vscode.Range(
          new vscode.Position(2, 9),
          new vscode.Position(2, 16)
        ),
        text: "newName",
      },
    ]);
  });

  it("falls back to token lookup when the plan omits columns", async () => {
    const client = {
      getWorkspacePath: () => "/workspace",
      renamePlan: jest.fn().mockResolvedValue({
        entity: { name: "probeFormat", kind: "Function", file: "src/demo.ts", line: 2 },
        newName: "probeFormatRenamed",
        edits: [
          {
            file: "src/demo.ts",
            line: 2,
          },
        ],
        warnings: [],
      }),
    };
    const manager = {
      getClientForPath: jest.fn(() => client),
    } as unknown as WorkspaceManager;
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
      lineCount: 3,
      lineAt: (line: number) => ({
        text: line === 1 ? "export function probeFormat(value: string) {" : "",
        range: new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, 42)
        ),
      }),
    });

    const provider = new KinRenameProvider(manager);
    const document = {
      uri: { fsPath: "/workspace/src/demo.ts" },
      getWordRangeAtPosition: () => new vscode.Range(new vscode.Position(1, 17), new vscode.Position(1, 28)),
      getText: () => "probeFormat",
    } as any;

    const edit = await provider.provideRenameEdits(
      document,
      new vscode.Position(1, 20),
      "probeFormatRenamed",
      {} as any
    );

    expect(edit).toBeInstanceOf(vscode.WorkspaceEdit);
    expect((edit as any).edits[0].range).toEqual(
      new vscode.Range(new vscode.Position(1, 16), new vscode.Position(1, 27))
    );
    expect((edit as any).edits[0].text).toBe("probeFormatRenamed");
  });
});
