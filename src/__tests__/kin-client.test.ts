// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { BinaryNotFoundError, ParseError, TimeoutError } from "../errors";

// Mock vscode module (not available outside VS Code host)
jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: () => ({
        get: () => "",
      }),
    },
    window: {
      withProgress: (_opts: unknown, task: () => Promise<unknown>) => task(),
    },
    ProgressLocation: {
      Notification: 15,
    },
  }),
  { virtual: true }
);

jest.mock("child_process");
jest.mock("fs");
jest.mock("../logger", () => ({
  log: jest.fn(),
  logError: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;

// Import after mocks are set up
import { KinClient } from "../kin-client";

describe("KinClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no configured binary, no ~/.kin/bin/kin, fall back to "kin" in PATH
    mockExistsSync.mockReturnValue(false);
  });

  describe("binary path resolution", () => {
    it("falls back to 'kin' when no binary found at known paths", () => {
      mockExistsSync.mockReturnValue(false);
      const client = new KinClient("/workspace");
      expect(client.isAvailable()).toBe(true);
    });

    it("uses ~/.kin/bin/kin when it exists", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p.includes(".kin/bin/kin")
      );
      const client = new KinClient("/workspace");
      expect(client.isAvailable()).toBe(true);
    });
  });

  describe("runJson — JSON parse error handling", () => {
    it("throws ParseError on invalid JSON output", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, "not valid json {{{", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("test")).rejects.toThrow(ParseError);
    });

    it("includes command name in ParseError message", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, "<html>not json</html>", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("query")).rejects.toThrow(
        /Failed to parse JSON response from kin search/
      );
    });

    it("parses valid JSON correctly", async () => {
      const entities = [
        { kind: "Function", name: "foo", file: "test.ts", line: 1 },
      ];
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify(entities), "");
        }
      );

      const client = new KinClient("/workspace");
      const result = await client.search("foo");
      expect(result).toEqual(entities);
    });

    it("passes relative paths to kin review --files", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify({ file: "src/demo.ts", findings: [], summary: "ok" }), "");
        }
      );

      const client = new KinClient("/workspace");
      await client.review("/workspace/src/demo.ts");

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.anything(),
        ["review", "--files", "src/demo.ts", "--json"],
        expect.objectContaining({ cwd: "/workspace" }),
        expect.any(Function)
      );
    });

    it("passes relative paths to kin rename --file", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(
            null,
            JSON.stringify({
              entity: { name: "foo", kind: "Function", file: "src/demo.ts", line: 1 },
              newName: "bar",
              edits: [],
              warnings: [],
            }),
            ""
          );
        }
      );

      const client = new KinClient("/workspace");
      await client.renamePlan("foo", "bar", "/workspace/src/demo.ts", 9, 5);

      expect(mockExecFile).toHaveBeenCalledWith(
        expect.anything(),
        ["rename", "foo", "bar", "--file", "src/demo.ts", "--line", "9", "--column", "5", "--json"],
        expect.objectContaining({ cwd: "/workspace" }),
        expect.any(Function)
      );
    });
  });

  describe("timeout behavior", () => {
    it("throws TimeoutError when command is killed by timeout", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error("Command timed out") as Error & {
            killed: boolean;
            signal: string;
          };
          err.killed = true;
          err.signal = "SIGTERM";
          cb(err, "", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("slow")).rejects.toThrow(TimeoutError);
    });

    it("includes timeout duration in TimeoutError message", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error("timed out") as Error & {
            killed: boolean;
            signal: string;
          };
          err.killed = true;
          err.signal = "SIGTERM";
          cb(err, "", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("slow")).rejects.toThrow(/15000ms/);
    });
  });

  describe("binary not found", () => {
    it("throws BinaryNotFoundError when binary does not exist (ENOENT)", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const err = new Error("spawn kin ENOENT") as Error & {
            code: string;
          };
          err.code = "ENOENT";
          cb(err, "", "");
        }
      );

      const client = new KinClient("/workspace");
      await expect(client.search("test")).rejects.toThrow(
        BinaryNotFoundError
      );
    });
  });

  describe("status fallback", () => {
    it("returns default status on error instead of throwing", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(new Error("repo not initialized"), "", "repo not initialized");
        }
      );

      const client = new KinClient("/workspace");
      const status = await client.status();
      expect(status).toEqual({
        initialized: false,
        entityCount: 0,
        graphState: "unknown",
      });
    });
  });

  describe("MCP contract handling", () => {
    it("parses semantic_locate results from MCP", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          results: [
            {
              kind: "Function",
              name: "foo",
              file_path: "src/foo.ts",
              start_line: 12,
              signature: "function foo()",
            },
          ],
        })),
      };

      const client = new KinClient("/workspace", mcp as never);
      const result = await client.search("foo");

      expect(mcp.callTool).toHaveBeenCalledWith(
        "semantic_locate",
        { query: "foo", limit: 50, granularity: "entity" },
        15_000
      );
      expect(result).toEqual([
        {
          kind: "Function",
          name: "foo",
          file: "src/foo.ts",
          line: 12,
          signature: "function foo()",
        },
      ]);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("loads entities through semantic_search instead of explore_codebase", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          results: [
            { kind: "Class", name: "Widget", file_path: "src/widget.ts", start_line: 3 },
          ],
        })),
      };

      const client = new KinClient("/workspace", mcp as never);
      await client.entities();

      expect(mcp.callTool).toHaveBeenCalledWith(
        "semantic_search",
        { query: "", limit: 5000, compact: true },
        30_000
      );
    });

    it("calls find_references with query and parses references", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          references: [
            {
              kind: "Function",
              name: "caller",
              file_path: "src/caller.ts",
              start_line: 7,
            },
          ],
        })),
      };

      const client = new KinClient("/workspace", mcp as never);
      const result = await client.trace("target");

      expect(mcp.callTool).toHaveBeenCalledWith(
        "find_references",
        { query: "target" },
        10_000
      );
      expect(result[0]).toMatchObject({
        name: "caller",
        file: "src/caller.ts",
        line: 7,
      });
    });

    it("maps structured MCP semantic_review comments to findings", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          summary: "Risk: Medium",
          inline_comments: [
            {
              file: "src/demo.ts",
              start_line: 4,
              kind: "CoverageGap",
              message: "New public entity has no test coverage",
            },
          ],
        })),
      };

      const client = new KinClient("/workspace", mcp as never);
      const result = await client.review("/workspace/src/demo.ts");

      expect(mcp.callTool).toHaveBeenCalledWith(
        "semantic_review",
        { files: ["src/demo.ts"], include_traffic: false, format: "json" },
        30_000
      );
      expect(result.findings).toEqual([
        {
          entity: "",
          kind: "CoverageGap",
          file: "src/demo.ts",
          line: 4,
          severity: "warning",
          message: "New public entity has no test coverage",
        },
      ]);
      expect(result.summary).toBe("Risk: Medium");
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});
