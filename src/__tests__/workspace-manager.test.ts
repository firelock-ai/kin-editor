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
      public connect = jest.fn().mockResolvedValue(undefined);
      public dispose = jest.fn();
      public onGraphChanged = jest.fn(() => ({ dispose: jest.fn() }));

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

  it("connects and subscribes only new clients, disposing removed ones exactly once", async () => {
    mockExistsSync.mockReturnValue(true);
    const folder = (name: string) => ({ name, index: 0, uri: { fsPath: `/workspace/${name}` } }) as unknown as vscode.WorkspaceFolder;
    const a = folder("a");
    const b = folder("b");
    const manager = new WorkspaceManager([a], true);
    const first = manager.allEntries()[0].mcpClient!;
    await manager.connectAll();
    await manager.connectAll();
    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(first.onGraphChanged).toHaveBeenCalledTimes(1);
    manager.syncWorkspaceFolders([a, b]);
    const second = manager.allEntries()[1].mcpClient!;
    await manager.connectAll();
    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
    const subscription = (first.onGraphChanged as jest.Mock).mock.results[0].value;
    manager.syncWorkspaceFolders([b]);
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    manager.syncWorkspaceFolders([a, b]);
    const replacement = manager.allEntries()[0].mcpClient!;
    expect(replacement).not.toBe(first);
    await manager.connectAll();
    expect(replacement.connect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
    manager.dispose();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight connection without duplicate subscriptions", async () => {
    mockExistsSync.mockReturnValue(true);
    const folder = { name: "a", index: 0, uri: { fsPath: "/workspace/a" } } as unknown as vscode.WorkspaceFolder;
    const manager = new WorkspaceManager([folder], true);
    const client = manager.allEntries()[0].mcpClient!;
    let finish!: () => void;
    (client.connect as jest.Mock).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = manager.connectAll();
    const second = manager.connectAll();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.onGraphChanged).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    manager.dispose();
  });
});
