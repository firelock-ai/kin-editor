// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

jest.mock(
  "vscode",
  () => {
    class Range {
      public readonly start: { line: number; character: number };
      public readonly end: { line: number; character: number };

      constructor(
        startLine: number,
        startCharacter: number,
        endLine: number,
        endCharacter: number
      ) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    }

    return {
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
      Range,
      ProgressLocation: {
        Notification: 15,
      },
      workspace: {
        getConfiguration: () => ({ get: () => "" }),
        openTextDocument: jest.fn(),
      },
      window: {
        showInputBox: jest.fn(),
        showQuickPick: jest.fn(),
        showTextDocument: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        withProgress: (_opts: unknown, task: () => Promise<unknown>) => task(),
      },
    };
  },
  { virtual: true }
);

import * as vscode from "vscode";
import { KinClient } from "../kin-client";
import { showSearchQuickPick } from "../search-panel";

describe("showSearchQuickPick", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("opens a selected graph-native result at its provenance file and span line", async () => {
    const query = "function that adds invoice subtotal and tax";
    const mcp = {
      isConnected: () => true,
      callTool: jest.fn().mockResolvedValue(JSON.stringify({
        entities: [
          {
            kind: "Function",
            name: "invoiceTotal",
            span: [5, 7],
            provenance: { file: "src/ledger.ts" },
          },
        ],
      })),
    };
    const client = new KinClient("/workspace", mcp as never);
    const document = { uri: { fsPath: "/workspace/src/ledger.ts" } };

    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(query);
    (vscode.window.showQuickPick as jest.Mock).mockImplementation(
      async (items: unknown[]) => items[0]
    );
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

    await showSearchQuickPick(client, "/workspace");

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
      fsPath: "/workspace/src/ledger.ts",
    });
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(document, {
      selection: expect.objectContaining({
        start: { line: 4, character: 0 },
        end: { line: 4, character: 0 },
      }),
    });
  });
});
