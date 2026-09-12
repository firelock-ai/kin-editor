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

    class Location {
      constructor(
        public uri: { fsPath: string },
        public rangeOrPosition: Position
      ) {}
    }

    class SymbolInformation {
      constructor(
        public name: string,
        public kind: number,
        public containerName: string,
        public location: Location
      ) {}
    }

    return {
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
      Position,
      Location,
      SymbolInformation,
      SymbolKind: {
        Function: 12,
        Method: 5,
        Class: 4,
        Struct: 23,
        Interface: 11,
        Enum: 9,
        Module: 2,
        Variable: 13,
        Constant: 14,
        Field: 8,
        Property: 7,
        Constructor: 9,
        TypeParameter: 26,
      },
    };
  },
  { virtual: true }
);

import * as vscode from "vscode";
import { KinWorkspaceSymbolProvider } from "../providers/symbol-provider";
import { WorkspaceManager } from "../workspace-manager";

describe("KinWorkspaceSymbolProvider", () => {
  it("maps symbol-search results from every workspace root to symbol information", async () => {
    const firstClient = {
      symbolSearch: jest.fn().mockResolvedValue([
        { name: "parseConfig", kind: "Function", file: "src/config.ts", line: 3 },
      ]),
    };
    const secondClient = {
      symbolSearch: jest.fn().mockResolvedValue([
        { name: "App", kind: "Class", file: "/shared/app.ts", line: 1 },
      ]),
    };
    const manager = {
      allEntries: jest.fn(() => [
        { client: firstClient, folder: { uri: { fsPath: "/first" } } },
        { client: secondClient, folder: { uri: { fsPath: "/second" } } },
      ]),
    } as unknown as WorkspaceManager;

    const provider = new KinWorkspaceSymbolProvider(manager);
    const symbols = await provider.provideWorkspaceSymbols("app", {} as vscode.CancellationToken);

    expect(firstClient.symbolSearch).toHaveBeenCalledWith("app");
    expect(secondClient.symbolSearch).toHaveBeenCalledWith("app");
    expect(symbols).toEqual([
      new vscode.SymbolInformation(
        "parseConfig",
        vscode.SymbolKind.Function,
        "src/config.ts",
        new vscode.Location(
          vscode.Uri.file("/first/src/config.ts"),
          new vscode.Position(2, 0)
        )
      ),
      new vscode.SymbolInformation(
        "App",
        vscode.SymbolKind.Class,
        "/shared/app.ts",
        new vscode.Location(
          vscode.Uri.file("/shared/app.ts"),
          new vscode.Position(0, 0)
        )
      ),
    ]);
  });

  it("does not search for queries shorter than two characters", async () => {
    const manager = {
      allEntries: jest.fn(),
    } as unknown as WorkspaceManager;

    const provider = new KinWorkspaceSymbolProvider(manager);

    await expect(provider.provideWorkspaceSymbols("a", {} as vscode.CancellationToken)).resolves.toEqual([]);
    expect(manager.allEntries).not.toHaveBeenCalled();
  });
});
