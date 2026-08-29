// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  BinaryNotFoundError,
  CliContractError,
  ParseError,
  TimeoutError,
} from "../errors";

const mockShowWarningMessage = jest.fn();

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
      showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
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

// `fs` is mocked above, so read the fixtures through the real module. These are
// the verbatim bytes a real kin 0.6.0 binary wrote; see cli-contract.test.ts.
const realReadFileSync = jest.requireActual("fs").readFileSync as typeof readFileSync;

interface CliFixture {
  capture: { command: string; kin_version: string };
  payload: unknown;
}

function loadCliFixture(name: string): CliFixture {
  return JSON.parse(
    realReadFileSync(join(__dirname, "fixtures", "cli", `${name}.json`), "utf8") as string
  ) as CliFixture;
}

const statusFixture = loadCliFixture("status");

describe("KinClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShowWarningMessage.mockClear();
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
    it("reports an unreachable runtime instead of claiming the repo is uninitialized", async () => {
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
        reachable: false,
      });
    });

    it("marks a status the CLI actually answered as reachable", async () => {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify(statusFixture.payload), "");
        }
      );

      const client = new KinClient("/workspace");
      const status = await client.status();
      expect(status.reachable).toBe(true);
      expect(status.initialized).toBe(true);
      expect(status.entityCount).toBe(14);
      expect(status.contractDrift).toBeUndefined();
    });

    it("reports a drifted CLI as reachable-but-mismatched, not unreachable", async () => {
      // The shape a pre-0.6 CLI answered with. It parses, so nothing throws;
      // before the contract check every field read `undefined` and the status
      // bar showed a confident "not initialized" on a healthy repository.
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
              version: 1,
              initialized: false,
              entityCount: 0,
              graphState: "uninitialized",
            }),
            ""
          );
        }
      );

      const client = new KinClient("/workspace");
      const status = await client.status();
      // Reachable, because the binary ran and answered.
      expect(status.reachable).toBe(true);
      expect(status.contractDrift).toEqual({
        command: "status",
        missing: ["schema", "repository", "semantic_enrichment"],
      });
      expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
      expect(mockShowWarningMessage.mock.calls[0][0]).toContain(
        "kin status --json"
      );
      expect(mockShowWarningMessage.mock.calls[0][0]).toContain(
        "semantic_enrichment"
      );
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
        30_000
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
        30_000
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

    it("marks overview as an invalid response (not an empty graph) when the MCP graph status is unparseable", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue("daemon still warming up"),
      };

      const client = new KinClient("/workspace", mcp as never);
      const overview = await client.overview();

      // A garbled reply is surfaced as invalid, distinct from a real empty graph.
      expect(overview.availability).toBe("invalid-response");
      expect(overview.indexed).toBe(false);
      expect(overview.entities).toBe(0);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("marks overview as indexed when the MCP graph status parses", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(
          JSON.stringify({ entity_count: 42, edge_count: 13, file_count: 7, kinds: { Function: 42 } })
        ),
      };

      const client = new KinClient("/workspace", mcp as never);
      const overview = await client.overview();

      expect(overview).toEqual({
        entities: 42,
        edges: 13,
        files: 7,
        kinds: { Function: 42 },
        indexed: true,
        availability: "indexed",
        compatFallback: false,
      });
    });

    it("marks a reachable-but-empty graph as empty, not indexed", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(
          JSON.stringify({ entity_count: 0, edge_count: 0, file_count: 0, kinds: {} })
        ),
      };

      const client = new KinClient("/workspace", mcp as never);
      const overview = await client.overview();

      expect(overview.availability).toBe("empty");
      expect(overview.indexed).toBe(false);
      expect(overview.compatFallback).toBe(false);
    });

    it("degrades to the CLI compatibility path (compatFallback) when the MCP graph call fails", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockRejectedValue(new Error("mcp broke")),
      };
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify({ entities: 5, edges: 1, files: 2, kinds: { Function: 5 } }), "");
        }
      );

      const client = new KinClient("/workspace", mcp as never);
      const overview = await client.overview();

      expect(overview.availability).toBe("indexed");
      expect(overview.compatFallback).toBe(true);
      expect(overview.entities).toBe(5);
      expect(mockExecFile).toHaveBeenCalled();
    });

    it("reports unavailable when both the MCP and CLI overview paths fail", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockRejectedValue(new Error("mcp down")),
      };
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(new Error("cli down"), "", "cli down");
        }
      );

      const client = new KinClient("/workspace", mcp as never);
      const overview = await client.overview();

      expect(overview.availability).toBe("unavailable");
      expect(overview.compatFallback).toBe(true);
      expect(overview.indexed).toBe(false);
    });

    it("coalesces concurrent traceQuick calls for the same word into one tool call", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(
          JSON.stringify({ references: [{ name: "foo", file_path: "src/foo.ts", start_line: 1 }] })
        ),
      };

      const client = new KinClient("/workspace", mcp as never);
      const [a, b] = await Promise.all([
        client.traceQuick("foo"),
        client.traceQuick("foo"),
      ]);

      expect(mcp.callTool).toHaveBeenCalledTimes(1);
      expect(a).toEqual(b);

      // A second call within the TTL reuses the cached result — still one call.
      await client.traceQuick("foo");
      expect(mcp.callTool).toHaveBeenCalledTimes(1);
    });

    it("symbolSearch uses semantic_search (name-pattern), not semantic_locate", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          results: [
            { kind: "Function", name: "myFunc", file_path: "src/utils.ts", start_line: 5 },
          ],
        })),
      };

      const client = new KinClient("/workspace", mcp as never);
      await client.symbolSearch("myFunc");

      expect(mcp.callTool).toHaveBeenCalledWith(
        "semantic_search",
        { query: "myFunc", limit: 50, compact: true },
        30_000
      );
    });
  });
  // -------------------------------------------------------------------------
  // The CLI fallback contract, end to end through the client
  // -------------------------------------------------------------------------
  describe("CLI fallback contract", () => {
    function serve(payload: unknown): void {
      mockExecFile.mockImplementation(
        (
          _bin: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          cb(null, JSON.stringify(payload), "");
        }
      );
    }

    /** The argv the client actually passed, rendered the way a fixture names it. */
    function invokedCommand(): string {
      const args = mockExecFile.mock.calls[0][1] as string[];
      return ["kin", ...args].join(" ");
    }

    // The join. Each fixture names the command that produced it exactly once,
    // in the fixture, and this derives the other half from what the client
    // actually spawned. Nothing hardcodes the command string twice, so renaming
    // a subcommand on either side has to break a test.
    it.each([
      ["status", () => new KinClient("/workspace").status()],
      ["overview", () => new KinClient("/workspace").overview()],
      ["search", () => new KinClient("/workspace").search("build_router")],
      ["trace", () => new KinClient("/workspace").trace("build_router")],
      ["review", () => new KinClient("/workspace").review("/workspace/app.py")],
    ] as const)(
      "%s spawns exactly the command its fixture was captured from",
      async (name, call) => {
        const fixture = loadCliFixture(name);
        serve(fixture.payload);
        await call();
        expect(invokedCommand()).toBe(fixture.capture.command);
      }
    );

    it("reads the real status payload with no warning", async () => {
      serve(loadCliFixture("status").payload);
      const status = await new KinClient("/workspace").status();
      expect(status.entityCount).toBe(14);
      expect(status.graphState).toBe("present, completion not attested");
      // The must-stay-silent control. An intact answer that still warns is a
      // guard that cries wolf, and a user learns to dismiss it.
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("reads the real overview payload with no warning", async () => {
      serve(loadCliFixture("overview").payload);
      const overview = await new KinClient("/workspace").overview();
      expect(overview.entities).toBe(14);
      expect(overview.availability).toBe("indexed");
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("reads the real search payload with no warning", async () => {
      serve(loadCliFixture("search").payload);
      const results = await new KinClient("/workspace").search("build_router");
      expect(results).toHaveLength(12);
      expect(results[0].name).toBe("build_router");
      expect(results[0].file).toBe("router.py");
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("reads the real trace payload with no warning", async () => {
      serve(loadCliFixture("trace").payload);
      const results = await new KinClient("/workspace").trace("build_router");
      expect(results).toHaveLength(1);
      expect(results[0].line).toBe(20);
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("reads the real review payload with no warning", async () => {
      serve(loadCliFixture("review").payload);
      const review = await new KinClient("/workspace").review("/workspace/app.py");
      expect(review.findings).toHaveLength(3);
      expect(review.summary).toBe("Overall risk: Low; 3 finding(s)");
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });

    it("throws a named CliContractError on a drifted search answer", async () => {
      // The 0.5-era search shape: an object, not an array.
      serve({ entities: [], files: [], summary: "none" });
      await expect(new KinClient("/workspace").search("x")).rejects.toThrow(
        CliContractError
      );
      expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
      expect(mockShowWarningMessage.mock.calls[0][0]).toContain("kin search --json");
    });

    it("throws rather than handing review-provider a findings-less object", async () => {
      // Before the contract check this returned an object with no findings key,
      // and the provider dereferenced .findings.length on undefined.
      serve({ risk: { overall_risk: "Low" }, inline_comments: [] });
      await expect(
        new KinClient("/workspace").review("/workspace/app.py")
      ).rejects.toThrow(CliContractError);
      expect(mockShowWarningMessage.mock.calls[0][0]).toContain("file, findings, summary");
    });

    it("reports overview drift as contract-drift, not as an unavailable graph", async () => {
      serve({ nodes: 3 });
      const overview = await new KinClient("/workspace").overview();
      expect(overview.availability).toBe("contract-drift");
      expect(overview.entities).toBe(0);
    });

    it("warns once per distinct drift, not once per call", async () => {
      serve({ version: 1, initialized: true, entityCount: 3, graphState: "ok" });
      const client = new KinClient("/workspace");
      await client.status();
      await client.status();
      await client.status();
      expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    });

    it("still reports the drift when the notification itself fails", async () => {
      // A failed notification must not replace a precise diagnosis with
      // whatever the UI threw, which the caller would report as unreachable.
      mockShowWarningMessage.mockImplementationOnce(() => {
        throw new Error("notification host is gone");
      });
      serve({ version: 1, initialized: true, entityCount: 3, graphState: "ok" });
      const status = await new KinClient("/workspace").status();
      expect(status.reachable).toBe(true);
      expect(status.contractDrift?.command).toBe("status");
    });

    it("does not warn on a query that simply found nothing", async () => {
      serve([]);
      const results = await new KinClient("/workspace").search("nothing_matches_this");
      expect(results).toEqual([]);
      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });
  });
});
