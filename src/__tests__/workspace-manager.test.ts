// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

jest.mock(
  "vscode",
  () => {
    class EventEmitter {
      event = jest.fn();
      fire = jest.fn();
      dispose = jest.fn();
    }

    return {
      EventEmitter,
      workspace: {
        getWorkspaceFolder: jest.fn(),
      },
    };
  },
  { virtual: true }
);

jest.mock("fs", () => ({
  existsSync: jest.fn(),
}));

jest.mock("../logger", () => ({
  log: jest.fn(),
}));

jest.mock("../kin-client", () => {
  return {
    KinClient: class KinClient {
      constructor(
        public workspacePath: string,
        public mcpClient?: unknown
      ) {}
    },
  };
});

jest.mock("../mcp-client", () => {
  return {
    McpClient: class McpClient {
      public connect = jest.fn();
      public dispose = jest.fn();

      constructor(public workspacePath: string) {}
    },
  };
});

import { existsSync } from "fs";
import * as vscode from "vscode";
import { WorkspaceManager } from "../workspace-manager";

const mockExistsSync = existsSync as jest.Mock;

describe("WorkspaceManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("syncs Kin-enabled folders as the workspace changes", () => {
    const folderA = {
      name: "repo-a",
      index: 0,
      uri: { fsPath: "/workspace/repo-a" },
    } as unknown as vscode.WorkspaceFolder;
    const folderB = {
      name: "repo-b",
      index: 1,
      uri: { fsPath: "/workspace/repo-b" },
    } as unknown as vscode.WorkspaceFolder;

    mockExistsSync.mockImplementation((path: string) => path.includes("repo-a"));

    const manager = new WorkspaceManager([folderA, folderB], false);

    expect(manager.size).toBe(1);
    expect(manager.primaryWorkspacePath()).toBe("/workspace/repo-a");

    mockExistsSync.mockImplementation((path: string) => path.includes("repo-b"));

    const changed = manager.syncWorkspaceFolders([folderA, folderB]);

    expect(changed).toBe(true);
    expect(manager.size).toBe(1);
    expect(manager.primaryWorkspacePath()).toBe("/workspace/repo-b");
  });
});
