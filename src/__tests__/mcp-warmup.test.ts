// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// A cold `kin mcp start` answers `isError` with its own "the repo daemon is
// still starting ... retry this call once the daemon is ready" text. Treating
// that as a failure is what turned a first-time user's first query into an
// empty pane: the error was caught at the call site, the CLI fallback ran, and
// nothing told the user to wait or try again.
//
// These tests drive the real classifier and the real retry loop with the
// warming payload in `fixtures/mcp/warming.json`, and pair every positive with
// a control that must NOT be classified as warming, because a classifier that
// says yes to everything is not a classifier.

import { readFileSync } from "fs";
import { join } from "path";

const mockShowWarningMessage = jest.fn();

jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => (key === "binaryPath" ? "" : undefined),
      }),
    },
    window: {
      withProgress: (_opts: unknown, task: () => Promise<unknown>) => task(),
      showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    },
    ProgressLocation: { Notification: 15 },
  }),
  { virtual: true }
);

jest.mock("child_process");
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return { ...actual, existsSync: jest.fn(() => false) };
});
jest.mock("../logger", () => ({ log: jest.fn(), logError: jest.fn() }));

import { execFile } from "child_process";
import { KinClient } from "../kin-client";
import { McpToolError, isWarmingText } from "../mcp-client";

const mockExecFile = execFile as unknown as jest.Mock;

interface WarmingFixture {
  capture: {
    tool: string;
    arguments: Record<string, unknown>;
    isError: boolean;
    elapsed_ms: number;
    provenance: string;
  };
  text: string;
  /** A real failure from the same server. Must never classify as warming. */
  not_warming: { text: string; provenance: string };
  not_warming_second: { text: string; provenance: string };
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "mcp", "warming.json"), "utf8")
) as WarmingFixture;

const WARMING_TEXT = fixture.text;
const NOT_WARMING_TEXT = fixture.not_warming.text;

// One constant used to serve both kinds of test below, and only one of them
// wanted a short budget. A test that must RETRY AND SUCCEED was racing a 60 ms
// wall clock: the schedule it needs is about 3 ms of backoff, but the deadline
// is real time, and under a full parallel suite the event loop stalls past it,
// so the retry gave up and the arm failed on host load rather than on the code.
// Measured on 2026-08-29: green alone in 1.1 s, four runs; failed twice inside
// the full 21-suite run at the same commit. The product budget is 90_000 ms, so
// nothing here is a claim about the shipped schedule.
//
// Split in two. A test that must succeed gets a budget it cannot lose to
// scheduling, which costs nothing because it returns on the first non-warming
// reply. A test that must GIVE UP keeps the short budget, because expiring is
// the behavior it exists to prove.
const PATIENT_WARMUP = { totalBudgetMs: 5_000, firstBackoffMs: 1, maxBackoffMs: 4 };
const EXPIRING_WARMUP = { totalBudgetMs: 60, firstBackoffMs: 1, maxBackoffMs: 4 };

function warmingMcp(replies: Array<"warm" | string>) {
  let call = 0;
  const callTool = jest.fn(async () => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    if (reply === "warm") {
      throw new McpToolError("semantic_locate", WARMING_TEXT);
    }
    return reply;
  });
  return { isConnected: () => true, callTool };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockShowWarningMessage.mockClear();
});

describe("isWarmingText", () => {
  it("classifies the captured warming reply as warming", () => {
    expect(isWarmingText(WARMING_TEXT)).toBe(true);
  });

  it("does NOT classify a real failure from the same server as warming", () => {
    // The control. Without it, a classifier that returns true unconditionally
    // passes every test above and turns every genuine error into an infinite
    // retry.
    expect(isWarmingText(NOT_WARMING_TEXT)).toBe(false);
  });

  it("does not classify empty or unrelated text as warming", () => {
    expect(isWarmingText("")).toBe(false);
    expect(isWarmingText("no repository is bound at this path")).toBe(false);
  });
});

describe("McpToolError", () => {
  it("flags a warming payload", () => {
    expect(new McpToolError("semantic_locate", WARMING_TEXT).warming).toBe(true);
  });

  it("does not flag a genuine failure", () => {
    expect(new McpToolError("semantic_locate", NOT_WARMING_TEXT).warming).toBe(false);
  });

  it("keeps the server's own text so the UI can show it", () => {
    expect(new McpToolError("semantic_locate", WARMING_TEXT).text).toBe(WARMING_TEXT);
  });
});

describe("KinClient warmup retry", () => {
  it("retries a warming reply and returns the answer it was asked to wait for", async () => {
    const entities = [
      { kind: "Function", name: "build_router", file: "router.py", line: 20 },
    ];
    const mcp = warmingMcp(["warm", "warm", JSON.stringify(entities)]);
    const client = new KinClient("/workspace", mcp as never, PATIENT_WARMUP);

    const results = await client.search("where is the router built");

    expect(results).toEqual(entities);
    expect(mcp.callTool).toHaveBeenCalledTimes(3);
    // The whole point: a warming daemon must not send the query to the CLI.
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("shows the server's own warming sentence, once", async () => {
    const mcp = warmingMcp(["warm", "warm", "[]"]);
    const client = new KinClient("/workspace", mcp as never, PATIENT_WARMUP);
    await client.search("q");

    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    const shown = mockShowWarningMessage.mock.calls[0][0] as string;
    expect(shown).toContain("still starting");
    expect(shown).toContain("retry this call once the daemon is ready");
  });

  it("raises the warming state rather than returning an empty list when it never warms", async () => {
    // Before this, a persistently warming daemon produced `[]` with no error,
    // which is indistinguishable from a repository containing nothing.
    const mcp = warmingMcp(["warm"]);
    const client = new KinClient("/workspace", mcp as never, EXPIRING_WARMUP);

    await expect(client.search("q")).rejects.toThrow(McpToolError);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("still falls back to the CLI on a genuine MCP error", async () => {
    // The control in the other direction. A fix that stops falling back on
    // every error would break the compatibility path this extension needs.
    const mcp = {
      isConnected: () => true,
      callTool: jest.fn().mockRejectedValue(new McpToolError("semantic_locate", NOT_WARMING_TEXT)),
    };
    mockExecFile.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        cb(null, JSON.stringify([{ kind: "Function", name: "f", file: "a.py", line: 1 }]), "");
      }
    );
    const client = new KinClient("/workspace", mcp as never, PATIENT_WARMUP);

    const results = await client.search("q");
    expect(results).toHaveLength(1);
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("reports overview warming as its own state, not as unavailable or empty", async () => {
    const mcp = warmingMcp(["warm"]);
    const client = new KinClient("/workspace", mcp as never, EXPIRING_WARMUP);

    const overview = await client.overview();
    expect(overview.availability).toBe("warming");
    // "unavailable" would send the user to check a binary that is running, and
    // "empty" would claim a graph state nobody measured.
    expect(overview.availability).not.toBe("unavailable");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("reports status warming as reachable, carrying the server's text", async () => {
    const mcp = warmingMcp(["warm"]);
    const client = new KinClient("/workspace", mcp as never, EXPIRING_WARMUP);

    const status = await client.status();
    expect(status.reachable).toBe(true);
    expect(status.graphState).toBe("starting");
    expect(status.warming).toBe(WARMING_TEXT);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("backs off between attempts rather than spinning", async () => {
    const mcp = warmingMcp(["warm", "warm", "warm", "[]"]);
    const client = new KinClient("/workspace", mcp as never, {
      totalBudgetMs: 5_000,
      firstBackoffMs: 20,
      maxBackoffMs: 40,
    });
    const started = Date.now();
    await client.search("q");
    // 20 + 40 + 40 = 100 ms of backoff across three warming replies.
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(mcp.callTool).toHaveBeenCalledTimes(4);
  });
});

describe("query timeout budget", () => {
  it("gives an interactive query 30s by default, not the old 15s", async () => {
    // A warm semantic query was measured at 24.0s on a loaded host, which the
    // old fixed 15000 would have killed and dropped onto the CLI fallback.
    const mcp = warmingMcp(["[]"]);
    const client = new KinClient("/workspace", mcp as never, PATIENT_WARMUP);
    await client.search("q");

    expect(mcp.callTool).toHaveBeenCalledWith(
      "semantic_locate",
      expect.objectContaining({ query: "q" }),
      30_000
    );
  });
});
describe("warming classifier, marker by marker", () => {
  // Each marker is asserted on its own, so a marker quietly deleted from the
  // list fails a named test instead of hiding behind the other two matching the
  // same fixture. Without this, the marker list could shrink to one entry and
  // every test above would still pass.
  it.each([
    ["still-starting", "the repo daemon is still starting (phase: spawning; 3s so far)"],
    ["retry-once-ready", "retry this call once the daemon is ready"],
    ["startup-latency", "This is startup latency, not a failure: do not restart anything."],
  ])("recognises the %s marker on its own", (_label, text) => {
    expect(isWarmingText(text)).toBe(true);
  });

  it("does not classify a second real kin failure as warming", () => {
    // A second control, drawn from the same product surface rather than
    // invented, because an invented sentence proves nothing about what the
    // producer actually says.
    expect(isWarmingText(fixture.not_warming_second.text)).toBe(false);
  });

  it("matches regardless of case", () => {
    expect(isWarmingText(WARMING_TEXT.toUpperCase())).toBe(true);
  });
});
