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
import { showSearchQuickPick, showTraceQuickPick } from "../search-panel";

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

describe("showTraceQuickPick", () => {
  const CALLER = "1fcd4028-6a1b-4c2d-8e3f-5a7b9c0d1e2f";

  afterEach(() => {
    jest.clearAllMocks();
  });

  function traceGraph(record: unknown) {
    return {
      isConnected: () => true,
      callTool: jest.fn(async (tool: string) => {
        if (tool === "find_references") {
          return JSON.stringify({
            references: [
              {
                entity_id: CALLER,
                name: "solve_dependencies",
                kind: "Function",
                projection: { path: "fastapi/dependencies/utils.py" },
                site_count: 1,
                sites: [{ line_in_entity: 43, callee: "get_dependant" }],
              },
            ],
          });
        }
        if (tool === "get_entity") {
          return JSON.stringify(record);
        }
        throw new Error(`unexpected tool ${tool}`);
      }),
    };
  }

  it("lists a caller by its projected file and sites, and opens at the site its record locates", async () => {
    const mcp = traceGraph({ id: CALLER, span: { start_line: 99 }, start_line: 100 });
    const client = new KinClient("/workspace", mcp as never);
    const document = { uri: { fsPath: "/workspace/fastapi/dependencies/utils.py" } };
    let listed: Array<{ label: string; description: string; detail: string }> = [];

    (vscode.window.showInputBox as jest.Mock).mockResolvedValue("get_dependant");
    (vscode.window.showQuickPick as jest.Mock).mockImplementation(
      async (items: Array<{ label: string; description: string; detail: string }>) => {
        listed = items;
        return items[0];
      }
    );
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

    await showTraceQuickPick(client, "/workspace");

    expect(listed.map(({ label, description, detail }) => ({ label, description, detail }))).toEqual([
      {
        label: "solve_dependencies",
        description: "Function - fastapi/dependencies/utils.py",
        detail: "Sites: +43 get_dependant",
      },
    ]);
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
      fsPath: "/workspace/fastapi/dependencies/utils.py",
    });
    // File line 99 + 1 + 43 = 143, which the editor's 0-based range holds as 142.
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(document, {
      selection: expect.objectContaining({
        start: { line: 142, character: 0 },
        end: { line: 142, character: 0 },
      }),
    });
  });

  it("opens the projected file without a selection when the record gives no position", async () => {
    const mcp = traceGraph({ id: CALLER });
    const client = new KinClient("/workspace", mcp as never);
    const document = { uri: { fsPath: "/workspace/fastapi/dependencies/utils.py" } };

    (vscode.window.showInputBox as jest.Mock).mockResolvedValue("get_dependant");
    (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (items: unknown[]) => items[0]);
    (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(document);

    await showTraceQuickPick(client, "/workspace");

    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(document);
  });
});
