// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Live MCP integration proof — beyond mocks.
//
// Unlike the mock-based unit tests, this suite spawns a REAL subprocess that
// speaks the exact MCP wire protocol McpClient implements (JSON-RPC 2.0 over
// stdio with Content-Length framing) and drives it through the real client:
// the initialize handshake, `tools/call`, server notifications, and explicit
// failure modes. The fixture (fixtures/mock-mcp-server.mjs) stands in for
// `kin mcp start` so the transport, framing, parsing, reconnection, and
// workspace targeting are all exercised without a live Kin daemon.
//
// Scope note: validating against the real `kin mcp start` binary (a live
// daemon) is a separate, daemon-dependent step and is intentionally NOT done
// here — these tests are hermetic and CPU-light so they run in ordinary CI.

import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

jest.mock(
  "vscode",
  () => {
    class EventEmitter {
      private listeners: Array<(value: unknown) => void> = [];
      event = (listener: (value: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: () => undefined };
      };
      fire = (value: unknown) => {
        for (const listener of this.listeners) listener(value);
      };
      dispose = () => {
        this.listeners = [];
      };
    }
    return {
      EventEmitter,
      workspace: { getConfiguration: () => ({ get: () => "" }) },
      window: {
        withProgress: (_opts: unknown, task: () => Promise<unknown>) => task(),
      },
      ProgressLocation: { Notification: 15 },
    };
  },
  { virtual: true }
);

jest.mock("../logger", () => ({
  initLogger: jest.fn(),
  log: jest.fn(),
  logError: jest.fn(),
}));

import { McpClient } from "../mcp-client";
import { KinClient } from "../kin-client";

jest.setTimeout(20_000);

const FIXTURE = join(__dirname, "fixtures", "mock-mcp-server.mjs");

const clients: McpClient[] = [];
const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kin-editor-mcp-")));
  tempDirs.push(dir);
  return dir;
}

async function connectClient(cwd: string): Promise<McpClient> {
  const client = new McpClient(cwd, {
    timeoutMs: 5_000,
    spawn: { command: process.execPath, args: [FIXTURE] },
  });
  clients.push(client);
  await client.connect();
  return client;
}

afterEach(() => {
  while (clients.length) {
    clients.pop()!.dispose();
  }
  delete process.env.MOCK_MCP_INVALID_STATUS;
  delete process.env.MOCK_MCP_EMPTY;
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP live integration (real subprocess, real stdio transport)", () => {
  it("performs the initialize handshake and reports connected", async () => {
    const client = await connectClient(makeWorkspace());
    expect(client.isConnected()).toBe(true);
  });

  it("exercises the graph status tool over the wire", async () => {
    const client = await connectClient(makeWorkspace());
    const status = await client.callToolJson<{
      entity_count: number;
      kinds: Record<string, number>;
    }>("kin_graph_status", {});
    expect(status.entity_count).toBe(3);
    expect(status.kinds).toEqual({ Function: 2, Class: 1 });
  });

  it("exercises the search tool over the wire", async () => {
    const client = await connectClient(makeWorkspace());
    const results = await client.callToolJson<{ results: unknown[] }>(
      "semantic_search",
      { query: "handler" }
    );
    expect(results.results).toHaveLength(2);
  });

  it("surfaces a protocol/tool error as a thrown error, not empty data", async () => {
    const client = await connectClient(makeWorkspace());
    await expect(client.callTool("__protocol_error__", {})).rejects.toThrow(
      /simulated tool failure/
    );
  });

  it("delivers a non-JSON tool payload verbatim so the client layer can classify it", async () => {
    const client = await connectClient(makeWorkspace());
    const text = await client.callTool("__emit_non_json__", {});
    // The transport delivers the raw text; classifying it as invalid (rather
    // than empty) is the KinClient parser's job — proven in the full-stack test
    // below and the kin-client unit tests.
    expect(text).toContain("not json");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("marks the client disconnected when the server process crashes", async () => {
    const client = await connectClient(makeWorkspace());
    expect(client.isConnected()).toBe(true);
    await expect(client.callTool("__crash__", {})).rejects.toThrow();
    expect(client.isConnected()).toBe(false);
  });

  it("reconnects to the intended workspace after a manual reconnect", async () => {
    const workspace = makeWorkspace();
    const client = await connectClient(workspace);
    await expect(client.callTool("__crash__", {})).rejects.toThrow();
    expect(client.isConnected()).toBe(false);

    await client.connect();
    expect(client.isConnected()).toBe(true);
    const echoed = await client.callToolJson<{ cwd: string }>("echo_cwd", {});
    expect(echoed.cwd).toBe(workspace);
  });

  it("connects each client to its own workspace and re-targets on a workspace switch", async () => {
    const workspaceA = makeWorkspace();
    const workspaceB = makeWorkspace();

    const clientA = await connectClient(workspaceA);
    const clientB = await connectClient(workspaceB);

    const cwdA = await clientA.callToolJson<{ cwd: string }>("echo_cwd", {});
    const cwdB = await clientB.callToolJson<{ cwd: string }>("echo_cwd", {});
    expect(cwdA.cwd).toBe(workspaceA);
    expect(cwdB.cwd).toBe(workspaceB);

    // Simulate a workspace switch: drop A, bring up a client on a new workspace.
    clientA.dispose();
    const workspaceC = makeWorkspace();
    const clientC = await connectClient(workspaceC);
    const cwdC = await clientC.callToolJson<{ cwd: string }>("echo_cwd", {});
    expect(cwdC.cwd).toBe(workspaceC);
    // The surviving client B is unaffected and still targets its workspace.
    const cwdBAgain = await clientB.callToolJson<{ cwd: string }>("echo_cwd", {});
    expect(cwdBAgain.cwd).toBe(workspaceB);
  });
});

describe("MCP live integration — full KinClient stack (beyond mocks)", () => {
  it("resolves an indexed overview through KinClient over the real transport", async () => {
    const workspace = makeWorkspace();
    const mcp = await connectClient(workspace);
    const kin = new KinClient(workspace, mcp);

    const overview = await kin.overview();
    expect(overview.availability).toBe("indexed");
    expect(overview.entities).toBe(3);
    expect(overview.compatFallback).toBe(false);
  });

  it("resolves search results through KinClient over the real transport", async () => {
    const workspace = makeWorkspace();
    const mcp = await connectClient(workspace);
    const kin = new KinClient(workspace, mcp);

    const results = await kin.search("handler");
    expect(results.length).toBe(2);
    expect(results[0]).toMatchObject({ name: "handler", file: "src/handler.ts", line: 10 });
  });

  it("classifies a non-JSON graph-status reply as invalid-response, not an empty graph", async () => {
    // Drive the exact 'broken daemon reply looks empty' trap over the wire.
    process.env.MOCK_MCP_INVALID_STATUS = "1";
    const workspace = makeWorkspace();
    const mcp = await connectClient(workspace);
    const kin = new KinClient(workspace, mcp);

    const overview = await kin.overview();
    expect(overview.availability).toBe("invalid-response");
    expect(overview.entities).toBe(0);
    expect(overview.indexed).toBe(false);
  });
});
