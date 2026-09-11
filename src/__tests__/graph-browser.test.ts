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
    return {
      EventEmitter,
      ThemeIcon,
      TreeItem,
      TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
      Uri: { file: (fsPath: string) => ({ fsPath }) },
      window: { createOutputChannel: () => ({ appendLine: jest.fn() }) },
    };
  },
  { virtual: true }
);

import { GraphBrowserProvider, OPEN_ENTITY_COMMAND } from "../graph-browser";
import type { KinEntity } from "../kin-client";

const ENTITIES: KinEntity[] = [
  {
    id: "id-build",
    name: "app.routes.build_router",
    kind: "Function",
    file: "src/routes.py",
    line: 20,
    language: "python",
  },
  {
    id: "id-router",
    name: "app.routes.Router",
    kind: "Class",
    file: "src/routes.py",
    line: 5,
  },
  {
    id: "id-connect",
    name: "app.db.connect",
    kind: "Function",
    file: "src/db.py",
    line: 9,
  },
  { id: "id-main", name: "main", kind: "Function", file: "main.py", line: 1 },
];

function client(overrides: Record<string, unknown> = {}) {
  return {
    overview: jest.fn().mockResolvedValue({
      entities: ENTITIES.length,
      edges: 0,
      files: 0,
      kinds: {},
      indexed: true,
      availability: "indexed",
      compatFallback: false,
    }),
    entities: jest.fn().mockResolvedValue(ENTITIES),
    ...overrides,
  } as any;
}

describe("the graph browser", () => {
  it("groups by namespace, then kind, and never by folder", async () => {
    const provider = new GraphBrowserProvider(client(), "ws-key");

    const roots = await provider.getChildren();
    const labels = roots.map((node) => provider.getTreeItem(node).label);

    expect(labels).toEqual(["app.db", "app.routes", "No namespace in the graph"]);
    // Nothing in the tree is a path. The entities above live in two files and
    // neither appears at any level.
    for (const label of labels) {
      expect(label).not.toContain("/");
      expect(label).not.toContain(".py");
    }
  });

  it("lists kinds under a namespace and entities under a kind", async () => {
    const provider = new GraphBrowserProvider(client(), "ws-key");

    const roots = await provider.getChildren();
    const routes = roots[1];
    const kinds = await provider.getChildren(routes);
    expect(kinds.map((node) => provider.getTreeItem(node).label)).toEqual([
      "Class (1)",
      "Function (1)",
    ]);

    const functions = await provider.getChildren(kinds[1]);
    const item = provider.getTreeItem(functions[0]);
    // The row shows the leaf name; the namespace is the row above it.
    expect(item.label).toBe("build_router");
    expect(item.description).toBe("Function");
  });

  it("opens an entity as a graph document, not as a file", async () => {
    const provider = new GraphBrowserProvider(client(), "ws-key");
    const roots = await provider.getChildren();
    const kinds = await provider.getChildren(roots[1]);
    const entities = await provider.getChildren(kinds[1]);
    const item = provider.getTreeItem(entities[0]);

    expect(item.command).toEqual({
      command: OPEN_ENTITY_COMMAND,
      title: "Open Kin Entity",
      arguments: [
        {
          entity: expect.objectContaining({ id: "id-build" }),
          workspaceKey: "ws-key",
        },
      ],
    });
    // `resourceUri` would hand the row to the editor's file decorations, which
    // is the file-first reading this tree replaces.
    expect(item.resourceUri).toBeUndefined();
    expect(item.tooltip).not.toContain("src/routes.py");
  });

  it("says so when an answer carried no graph id, instead of failing silently", async () => {
    const provider = new GraphBrowserProvider(
      client({
        entities: jest
          .fn()
          .mockResolvedValue([
            { name: "orphan", kind: "Function", file: "a.py", line: 1 },
          ]),
      }),
      "ws-key"
    );
    const roots = await provider.getChildren();
    const kinds = await provider.getChildren(roots[0]);
    const entities = await provider.getChildren(kinds[0]);
    const item = provider.getTreeItem(entities[0]);

    expect(item.contextValue).toBe("kinEntityWithoutId");
    expect(item.tooltip).toContain("not opened as a graph document");
  });

  it("shows the graph's own state rather than an empty tree", async () => {
    for (const [availability, label] of [
      ["warming", "Kin graph is starting up"],
      ["unavailable", "Kin graph unavailable"],
      ["invalid-response", "Kin graph returned an unreadable response"],
      ["contract-drift", "Kin CLI version mismatch"],
      ["not-indexed", "Graph not indexed yet"],
    ] as const) {
      const entities = jest.fn();
      const provider = new GraphBrowserProvider(
        client({
          overview: jest.fn().mockResolvedValue({
            entities: 0,
            edges: 0,
            files: 0,
            kinds: {},
            indexed: false,
            availability,
            compatFallback: false,
          }),
          entities,
        }),
        "ws-key"
      );

      const roots = await provider.getChildren();
      expect(roots).toHaveLength(1);
      expect(provider.getTreeItem(roots[0]).label).toBe(label);
      // The cheap call already answered; asking for entities on a graph that
      // cannot serve them is the round trip this branch exists to avoid.
      expect(entities).not.toHaveBeenCalled();
    }
  });

  it("says the graph is empty when it really is", async () => {
    const provider = new GraphBrowserProvider(
      client({ entities: jest.fn().mockResolvedValue([]) }),
      "ws-key"
    );
    const roots = await provider.getChildren();
    expect(provider.getTreeItem(roots[0]).label).toBe("No entities found");
  });

  it("says the graph is unavailable when the load throws", async () => {
    const provider = new GraphBrowserProvider(
      client({ entities: jest.fn().mockRejectedValue(new Error("daemon down")) }),
      "ws-key"
    );
    const roots = await provider.getChildren();
    expect(provider.getTreeItem(roots[0]).label).toBe("Kin graph unavailable");
  });

  it("loads the graph once and again after a refresh", async () => {
    const loader = client();
    const provider = new GraphBrowserProvider(loader, "ws-key");

    await provider.getChildren();
    await provider.getChildren();
    expect(loader.entities).toHaveBeenCalledTimes(1);

    provider.refresh();
    await provider.getChildren();
    expect(loader.entities).toHaveBeenCalledTimes(2);
  });
});
