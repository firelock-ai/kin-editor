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

    it("normalizes graph-native semantic_locate provenance and spans for navigation", async () => {
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          entities: [
            {
              kind: "Function",
              name: "invoiceTotal",
              signature: "function invoiceTotal(subtotal: number, tax: number)",
              span: [5, 7],
              provenance: { file: "src/ledger.ts" },
            },
          ],
          files: [
            {
              path: "src/ledger.ts",
              symbols: ["invoiceTotal"],
            },
          ],
        })),
      };

      const client = new KinClient("/workspace", mcp as never);
      const result = await client.search("function that adds invoice subtotal and tax");

      expect(result).toEqual([
        {
          kind: "Function",
          name: "invoiceTotal",
          file: "src/ledger.ts",
          line: 5,
          signature: "function invoiceTotal(subtotal: number, tax: number)",
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
              entity_id: "5b1e0c8a-2f4d-4e6a-9b7c-1d3f5a7c9e02",
              kind: "Function",
              name: "caller",
              role: "source",
              projection: { path: "src/caller.ts" },
              site_count: 1,
              sites: [{ line_in_entity: 6, callee: "target" }],
              sites_absent_reason: null,
              sites_partial_reason: null,
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
      expect(result[0]).toEqual({
        id: "5b1e0c8a-2f4d-4e6a-9b7c-1d3f5a7c9e02",
        kind: "Function",
        name: "caller",
        file: "src/caller.ts",
        sites: [{ lineInEntity: 6, callee: "target" }],
      });
      // The row carries no file line, and none is made up for it.
      expect(result[0].line).toBeUndefined();
    });

    it.each([
      { findings: [], summary: "0 findings" },
      { inline_comments: [], summary: "0 findings" },
      { summary: "0 findings" },
    ])("preserves selected MCP review limits across readable shapes: %j", async (shape) => {
      const enrichment = {
        scope: "committed_graph", selected_change: "historical-revision",
        status: "bounded", limitation: "The selected revision has unresolved calls.",
        total_pending_entities: 2, pending_entities: [], entities_withheld: 2,
      };
      const verdict = {
        state: "inconclusive", safe_to_conclude_absent: false,
        limiting_factor: "enrichment_incomplete",
      };
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          ...shape, impact: { enrichment }, _kin: { envelope_version: 2, verdict },
        })),
      };
      const result = await new KinClient("/workspace", mcp as never).review("/workspace/src/demo.ts");
      expect(result.findings).toEqual([]);
      expect(result.enrichment).toEqual(enrichment);
      expect(result.verdict).toEqual(verdict);
      expect(result.envelopeVersion).toBe(2);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("retains an unknown MCP verdict without inventing enrichment", async () => {
      const verdict = { state: "future-state", limiting_factor: "future-condition" };
      const mcp = {
        isConnected: () => true,
        callTool: jest.fn().mockResolvedValue(JSON.stringify({
          inline_comments: [], _kin: { verdict },
        })),
      };
      const result = await new KinClient("/workspace", mcp as never).review("/workspace/src/demo.ts");
      expect(result.verdict).toEqual(verdict);
      expect(result).not.toHaveProperty("enrichment");
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
          JSON.stringify({
            references: [
              {
                entity_id: "0a4c6e82-1b3d-4f5a-8c7e-9d1f3b5a7c90",
                name: "foo",
                kind: "Function",
                projection: { path: "src/foo.ts" },
                site_count: 1,
                sites: [{ line_in_entity: 0, callee: "foo" }],
              },
            ],
          })
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

    describe("opening a find_references row", () => {
      const CALLER = "1fcd4028-6a1b-4c2d-8e3f-5a7b9c0d1e2f";

      /** An MCP stand-in answering find_references with `row` and get_entity with `record`. */
      function graph(row: Record<string, unknown>, record: unknown) {
        return {
          isConnected: () => true,
          callTool: jest.fn(async (tool: string, args: Record<string, unknown>) => {
            if (tool === "find_references") {
              return JSON.stringify({
                focal_entity: {
                  name: "get_dependant",
                  projection: { path: "fastapi/dependencies/utils.py" },
                },
                references: [row],
              });
            }
            if (tool === "get_entity") {
              if (record instanceof Error) {
                throw record;
              }
              expect(args).toEqual({ entity_id: CALLER });
              return JSON.stringify(record);
            }
            throw new Error(`unexpected tool ${tool}`);
          }),
        };
      }

      const row = {
        entity_id: CALLER,
        name: "solve_dependencies",
        kind: "Function",
        role: "source",
        projection: { path: "fastapi/dependencies/utils.py" },
        site_count: 1,
        sites: [{ line_in_entity: 43, callee: "get_dependant" }],
        sites_absent_reason: null,
        sites_partial_reason: "incomplete_call_evidence",
        relation_kinds: ["calls"],
        resolution: "type_resolved",
        via_override_of: null,
      };

      /** A get_entity record whose span starts on 0-based graph line `spanStart`. */
      function record(spanStart: number) {
        return {
          id: CALLER,
          kind: "function",
          name: "solve_dependencies",
          file_origin: "fastapi/dependencies/utils.py",
          span: {
            file: "fastapi/dependencies/utils.py",
            start_byte: 0,
            end_byte: 1,
            start_line: spanStart,
            start_col: 0,
            end_line: spanStart + 80,
            end_col: 0,
          },
          start_line: spanStart + 1,
          end_line: spanStart + 81,
        };
      }

      it("reads the focal's projected file when a reply carries no reference rows", async () => {
        // The entity fallback: a reply with a focal and no `references` array
        // names the focal, whose file is only its labelled projection.
        const mcp = {
          isConnected: () => true,
          callTool: jest.fn(async () =>
            JSON.stringify({
              focal_entity: {
                id: CALLER,
                name: "get_dependant",
                kind: "Function",
                projection: { path: "fastapi/dependencies/utils.py" },
              },
            })
          ),
        };
        const client = new KinClient("/workspace", mcp as never);
        const [focal] = await client.trace("get_dependant");

        expect(focal).toMatchObject({
          id: CALLER,
          name: "get_dependant",
          file: "fastapi/dependencies/utils.py",
        });
      });

      it("normalizes the row to its projected file and its sites, with no line", async () => {
        const client = new KinClient("/workspace", graph(row, record(0)) as never);
        const [reference] = await client.trace("get_dependant");

        expect(reference).toEqual({
          id: CALLER,
          kind: "Function",
          name: "solve_dependencies",
          file: "fastapi/dependencies/utils.py",
          sites: [{ lineInEntity: 43, callee: "get_dependant" }],
          sitesPartialReason: "incomplete_call_evidence",
        });
      });

      it("computes the site's file line from the caller's entity record, not from the row", async () => {
        // The same row against two records that disagree about where the
        // caller starts. The jump follows the record each time, so nothing in
        // the row is being read as a line.
        for (const [spanStart, expected] of [
          [99, 99 + 1 + 43],
          [310, 310 + 1 + 43],
        ]) {
          const mcp = graph(row, record(spanStart));
          const client = new KinClient("/workspace", mcp as never);
          const [reference] = await client.trace("get_dependant");
          const targets = await client.referenceTargets(reference);

          expect(mcp.callTool).toHaveBeenCalledWith(
            "get_entity",
            { entity_id: CALLER },
            30_000
          );
          expect(targets).toEqual([
            {
              file: "fastapi/dependencies/utils.py",
              line: expected,
              site: { lineInEntity: 43, callee: "get_dependant" },
            },
          ]);
        }
      });

      it("lands on the caller's own start_line when no site has a line", async () => {
        const withoutSites = {
          ...row,
          site_count: 0,
          sites: [],
          sites_absent_reason: "no_evidence_span",
          sites_partial_reason: null,
        };
        const client = new KinClient("/workspace", graph(withoutSites, record(99)) as never);
        const [reference] = await client.trace("get_dependant");

        expect(await client.referenceTargets(reference)).toEqual([
          { file: "fastapi/dependencies/utils.py", line: 100 },
        ]);
      });

      it("skips a site outside the caller's span and falls back to the caller", async () => {
        const outside = {
          ...row,
          sites: [{ line_in_entity: null, callee: "get_dependant" }],
        };
        const client = new KinClient("/workspace", graph(outside, record(99)) as never);
        const [reference] = await client.trace("get_dependant");

        expect(reference.sites).toEqual([{ lineInEntity: null, callee: "get_dependant" }]);
        expect(await client.referenceTargets(reference)).toEqual([
          { file: "fastapi/dependencies/utils.py", line: 100 },
        ]);
      });

      it("opens the projected file with no line when the record cannot be read", async () => {
        const client = new KinClient(
          "/workspace",
          graph(row, new Error("Entity not found")) as never
        );
        const [reference] = await client.trace("get_dependant");

        expect(await client.referenceTargets(reference)).toEqual([
          { file: "fastapi/dependencies/utils.py" },
        ]);
      });

      it("opens the projected file with no line when the record has no span", async () => {
        const { span: _span, start_line: _start, ...spanless } = record(99);
        const client = new KinClient("/workspace", graph(row, spanless) as never);
        const [reference] = await client.trace("get_dependant");

        expect(await client.referenceTargets(reference)).toEqual([
          { file: "fastapi/dependencies/utils.py" },
        ]);
      });

      it("refuses a record for another entity than the one asked for", async () => {
        const client = new KinClient(
          "/workspace",
          graph(row, { ...record(99), id: "ffffffff-0000-4000-8000-000000000000" }) as never
        );
        const [reference] = await client.trace("get_dependant");

        expect(await client.referenceTargets(reference)).toEqual([
          { file: "fastapi/dependencies/utils.py" },
        ]);
      });

      it("asks for nothing when the row has no entity id to ask about", async () => {
        const federated = { ...row, entity_id: null, projection: { path: "other-repo:src/x.py" } };
        const mcp = graph(federated, record(99));
        const client = new KinClient("/workspace", mcp as never);
        const [reference] = await client.trace("get_dependant");

        expect(await client.referenceTargets(reference)).toEqual([
          { file: "other-repo:src/x.py" },
        ]);
        expect(mcp.callTool).not.toHaveBeenCalledWith("get_entity", expect.anything(), expect.anything());
      });

      it("keeps a line an older daemon served, without asking for the record", async () => {
        const legacy = {
          entity_id: CALLER,
          kind: "Function",
          name: "solve_dependencies",
          file_path: "fastapi/dependencies/utils.py",
          start_line: 100,
          reference_lines: [144],
        };
        const mcp = graph(legacy, record(99));
        const client = new KinClient("/workspace", mcp as never);
        const [reference] = await client.trace("get_dependant");

        expect(reference).toMatchObject({ file: "fastapi/dependencies/utils.py", line: 100 });
        expect(await client.referenceTargets(reference)).toEqual([
          { file: "fastapi/dependencies/utils.py", line: 100 },
        ]);
        expect(mcp.callTool).not.toHaveBeenCalledWith("get_entity", expect.anything(), expect.anything());
      });

      it("reads one caller's record once for a hover and the click after it", async () => {
        const mcp = graph(row, record(99));
        const client = new KinClient("/workspace", mcp as never);
        const [reference] = await client.trace("get_dependant");

        await Promise.all([
          client.referenceTargets(reference, 3_000),
          client.referenceTargets(reference, 3_000),
        ]);
        await client.referenceTargets(reference, 3_000);

        const recordCalls = mcp.callTool.mock.calls.filter(([tool]) => tool === "get_entity");
        expect(recordCalls).toHaveLength(1);
      });
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
      expect(review).not.toHaveProperty("enrichment");
      expect(review).not.toHaveProperty("verdict");
    });

    it("retains bounded CLI review evidence with no findings", async () => {
      const enrichment = {
        status: "bounded", scope: "selected_graph_repository", selected_change: null,
        limitation: "Impact counts are a lower bound.", total_pending_entities: 1,
        pending_entities: [{ entity_id: "held", name: "caller", projection: { path: "app.py" } }],
      };
      serve({ file: "app.py", findings: [], summary: "0 findings", enrichment });
      const review = await new KinClient("/workspace").review("/workspace/app.py");
      expect(review.findings).toEqual([]);
      expect(review.enrichment).toEqual(enrichment);
      expect(review).not.toHaveProperty("verdict");
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
