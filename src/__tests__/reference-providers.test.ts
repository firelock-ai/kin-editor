// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Go-to-definition and hover over `find_references` rows.
//
// A row addresses its caller by entity id, names the file the caller is
// projected into, and counts each site from 0 inside the caller. These tests
// drive the real providers through a real KinClient over a stand-in MCP
// connection, and prove the jump lands where the caller's entity record puts
// the site while the hover shows sites inside the caller and no file line.

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
        public range: Position
      ) {}
    }

    class MarkdownString {
      value = "";
      supportThemeIcons = false;
      appendMarkdown(text: string): this {
        this.value += text;
        return this;
      }
      appendCodeblock(code: string, language: string): this {
        this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
        return this;
      }
    }

    class Hover {
      constructor(
        public contents: MarkdownString,
        public range: unknown
      ) {}
    }

    return {
      Uri: { file: (fsPath: string) => ({ fsPath }) },
      Position,
      Location,
      MarkdownString,
      Hover,
      workspace: { getConfiguration: () => ({ get: () => "" }) },
      window: { showWarningMessage: jest.fn() },
    };
  },
  { virtual: true }
);

jest.mock("../logger", () => ({
  log: jest.fn(),
  logError: jest.fn(),
}));

import * as vscode from "vscode";
import { KinClient } from "../kin-client";
import { KinDefinitionProvider } from "../providers/definition-provider";
import { KinHoverProvider } from "../providers/hover-provider";
import { WorkspaceManager } from "../workspace-manager";

const CALLER = "1fcd4028-6a1b-4c2d-8e3f-5a7b9c0d1e2f";

const ROW = {
  entity_id: CALLER,
  name: "solve_dependencies",
  kind: "Function",
  role: "source",
  projection: { path: "fastapi/dependencies/utils.py" },
  site_count: 2,
  sites: [
    { line_in_entity: 43, callee: "get_dependant" },
    { line_in_entity: 57, callee: "get_dependant" },
  ],
  sites_absent_reason: null,
  sites_partial_reason: null,
  relation_kinds: ["calls"],
  resolution: "type_resolved",
  via_override_of: null,
};

/** The caller's record: its span starts on 0-based graph line 120. */
const RECORD = {
  id: CALLER,
  kind: "function",
  name: "solve_dependencies",
  file_origin: "fastapi/dependencies/utils.py",
  span: {
    file: "fastapi/dependencies/utils.py",
    start_byte: 0,
    end_byte: 1,
    start_line: 120,
    start_col: 0,
    end_line: 200,
    end_col: 0,
  },
  start_line: 121,
  end_line: 201,
};

function setup(rows: unknown[] = [ROW]) {
  const mcp = {
    isConnected: () => true,
    callTool: jest.fn(async (tool: string) => {
      if (tool === "find_references") {
        return JSON.stringify({ references: rows });
      }
      if (tool === "get_entity") {
        return JSON.stringify(RECORD);
      }
      throw new Error(`unexpected tool ${tool}`);
    }),
  };
  const client = new KinClient("/workspace", mcp as never);
  const manager = {
    getClientForPath: () => client,
  } as unknown as WorkspaceManager;
  const document = {
    uri: { fsPath: "/workspace/fastapi/routing.py" },
    getWordRangeAtPosition: () => ({ start: 0, end: 13 }),
    getText: () => "get_dependant",
  } as unknown as vscode.TextDocument;
  return { mcp, manager, document };
}

describe("KinDefinitionProvider over find_references rows", () => {
  it("returns one location per site, each at the line the caller's record gives", async () => {
    const { mcp, manager, document } = setup();
    const provider = new KinDefinitionProvider(manager);

    const result = (await provider.provideDefinition(
      document,
      new vscode.Position(0, 0),
      {} as vscode.CancellationToken
    )) as vscode.Location[];

    expect(mcp.callTool).toHaveBeenCalledWith("get_entity", { entity_id: CALLER }, 3_000);
    // 0-based editor lines: record span start 120, plus 1 for the 1-based file
    // line, plus line_in_entity, minus 1 back to the editor's 0-based line.
    expect(result.map((location) => [location.uri.fsPath, location.range])).toEqual([
      ["/workspace/fastapi/dependencies/utils.py", new vscode.Position(120 + 43, 0)],
      ["/workspace/fastapi/dependencies/utils.py", new vscode.Position(120 + 57, 0)],
    ]);
  });

  it("jumps straight to a lone site", async () => {
    const { manager, document } = setup([
      { ...ROW, site_count: 1, sites: [{ line_in_entity: 43, callee: "get_dependant" }] },
    ]);
    const provider = new KinDefinitionProvider(manager);

    const result = (await provider.provideDefinition(
      document,
      new vscode.Position(0, 0),
      {} as vscode.CancellationToken
    )) as vscode.Location;

    expect(result.uri.fsPath).toBe("/workspace/fastapi/dependencies/utils.py");
    expect(result.range).toEqual(new vscode.Position(163, 0));
  });
});

describe("KinHoverProvider over find_references rows", () => {
  it("shows the projected file and each site as +N callee, with no file line", async () => {
    const { mcp, manager, document } = setup();
    const provider = new KinHoverProvider(manager);

    const hover = (await provider.provideHover(
      document,
      new vscode.Position(0, 0),
      {} as vscode.CancellationToken
    )) as unknown as { contents: { value: string } };

    const text = hover.contents.value;
    expect(text).toContain(
      "- `Function` **solve_dependencies** in `fastapi/dependencies/utils.py` at `+43 get_dependant, +57 get_dependant`"
    );
    // No `path:line` pair: the row served no file line and the hover derives none.
    expect(text).not.toMatch(/utils\.py:\d/);
    // Hover renders from the reply alone; it reads no entity record.
    expect(mcp.callTool).not.toHaveBeenCalledWith("get_entity", expect.anything(), expect.anything());
  });
});
