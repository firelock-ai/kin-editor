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

    class ThemeIcon {
      constructor(public id: string) {}
    }

    class TreeItem {
      accessibilityInformation: unknown;
      command: unknown;
      contextValue: string | undefined;
      description: string | undefined;
      iconPath: unknown;
      resourceUri: unknown;
      tooltip: unknown;

      constructor(
        public label: string,
        public collapsibleState: number
      ) {}
    }

    class Range {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number
      ) {}
    }

    return {
      EventEmitter,
      ThemeIcon,
      TreeItem,
      TreeItemCollapsibleState: {
        Collapsed: 1,
        None: 0,
      },
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
      Range,
    };
  },
  { virtual: true }
);

import { EntityExplorerProvider } from "../entity-explorer";

describe("EntityExplorerProvider", () => {
  it("loads all entities once and filters by kind when expanding a group", async () => {
    const client = {
      overview: jest.fn().mockResolvedValue({
        entities: 3,
        edges: 0,
        files: 0,
        kinds: { Function: 2, Class: 1 },
        indexed: true,
      }),
      entities: jest.fn().mockResolvedValue([
        { kind: "Function", name: "alpha", file: "src/a.ts", line: 3 },
        { kind: "Class", name: "Beta", file: "src/b.ts", line: 8 },
        { kind: "Function", name: "gamma", file: "src/c.ts", line: 21 },
      ]),
      search: jest.fn(),
    } as any;

    const provider = new EntityExplorerProvider(client, "/workspace");

    const groups = await provider.getChildren();
    expect(groups).toHaveLength(2);

    const functionGroup = groups.find(
      (group) => group.type === "kind" && group.kind === "Function"
    ) as any;
    expect(provider.getTreeItem(functionGroup).accessibilityInformation).toEqual({
      label: "Function group with 2 entities",
      role: "treeitem",
    });

    const functionEntities = await provider.getChildren(functionGroup);
    expect(client.entities).toHaveBeenCalledTimes(1);
    expect(client.search).not.toHaveBeenCalled();
    expect(functionEntities).toHaveLength(2);

    const firstEntityItem = provider.getTreeItem(functionEntities[0] as any);
    expect(firstEntityItem.label).toBe("alpha");
    expect(firstEntityItem.description).toBe("Function - src/a.ts:3");
    expect(firstEntityItem.tooltip).toBe("Function alpha\nsrc/a.ts:3");
    expect(firstEntityItem.accessibilityInformation).toEqual({
      label: "Function alpha, src/a.ts line 3",
      role: "treeitem",
    });
  });

  it("shows an honest 'not indexed' node instead of an empty tree when the graph is not indexed", async () => {
    const client = {
      overview: jest.fn().mockResolvedValue({
        entities: 0,
        edges: 0,
        files: 0,
        kinds: {},
        indexed: false,
      }),
      entities: jest.fn(),
    } as any;

    const provider = new EntityExplorerProvider(client, "/workspace");
    const nodes = await provider.getChildren();

    expect(nodes).toHaveLength(1);
    expect((nodes[0] as any).type).toBe("info");
    expect(client.entities).not.toHaveBeenCalled();
    const item = provider.getTreeItem(nodes[0]);
    expect(item.label).toBe("Graph not indexed yet");
  });

  it("shows an honest 'no entities' node when the graph is indexed but empty", async () => {
    const client = {
      overview: jest.fn().mockResolvedValue({
        entities: 0,
        edges: 0,
        files: 0,
        kinds: {},
        indexed: true,
      }),
      entities: jest.fn().mockResolvedValue([]),
    } as any;

    const provider = new EntityExplorerProvider(client, "/workspace");
    const nodes = await provider.getChildren();

    expect(nodes).toHaveLength(1);
    expect((nodes[0] as any).type).toBe("info");
    expect(provider.getTreeItem(nodes[0]).label).toBe("No entities found");
  });

  it("shows an honest 'unavailable' node when the overview call throws", async () => {
    const client = {
      overview: jest.fn().mockRejectedValue(new Error("daemon down")),
      entities: jest.fn(),
    } as any;

    const provider = new EntityExplorerProvider(client, "/workspace");
    const nodes = await provider.getChildren();

    expect(nodes).toHaveLength(1);
    expect(provider.getTreeItem(nodes[0]).label).toBe("Kin graph unavailable");
  });
});
