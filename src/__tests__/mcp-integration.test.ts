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

import { McpClient, McpToolError } from "../mcp-client";
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

/**
 * Wait until the real child-process stdout listener has retained a specific
 * byte state. This white-box observation is deliberate: the fixture does not
 * release its second write until the first write is visible here, so OS pipe
 * coalescing cannot turn a fragmented-frame regression into a false pass.
 */
async function waitForBufferedBytes(
  client: McpClient,
  predicate: (bytes: Buffer) => boolean,
  description: string,
): Promise<Buffer> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const candidate = (client as unknown as { buffer: unknown }).buffer;
    if (!Buffer.isBuffer(candidate)) {
      throw new Error("MCP receive state is not byte-buffered");
    }
    const snapshot = Buffer.from(candidate);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`MCP did not retain ${description} within 5000ms`);
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

describe("MCP frame reader state boundaries", () => {
  it("retains exact byte state across a partial header, split code point, and coalesced frame", () => {
    const client = new McpClient(makeWorkspace());
    clients.push(client);

    const received: string[] = [];
    const reader = client as unknown as {
      onData: (chunk: Buffer) => void;
      handleMessage: (raw: string) => void;
    };
    reader.handleMessage = (raw) => received.push(raw);

    const firstPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      result: { content: [{ type: "text", text: "graph → ready" }] },
    });
    const secondPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      result: { content: [{ type: "text", text: "next frame" }] },
    });
    const makeFrame = (payload: string) =>
      Buffer.concat([
        Buffer.from(
          `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`,
          "ascii",
        ),
        Buffer.from(payload, "utf-8"),
      ]);
    const firstFrame = makeFrame(firstPayload);
    const secondFrame = makeFrame(secondPayload);
    const firstCrlfEnd = firstFrame.indexOf("\r\n") + 2;
    const arrowStart = firstFrame.indexOf(Buffer.from("→", "utf-8"));
    expect(firstCrlfEnd).toBeGreaterThan(1);
    expect(arrowStart).toBeGreaterThan(firstCrlfEnd);

    // Feed 1 ends after the first header CRLF. Nothing can dispatch yet.
    reader.onData(firstFrame.subarray(0, firstCrlfEnd));
    expect(received).toEqual([]);

    // Feed 2 completes the header but stops after byte one of a three-byte
    // arrow. Decoding this chunk independently would corrupt the code point.
    reader.onData(firstFrame.subarray(firstCrlfEnd, arrowStart + 1));
    expect(received).toEqual([]);

    // Feed 3 finishes the code point and carries the next complete frame in
    // the same chunk. The reader must drain both payloads in order.
    reader.onData(
      Buffer.concat([firstFrame.subarray(arrowStart + 1), secondFrame]),
    );
    expect(received).toEqual([firstPayload, secondPayload]);
  });
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

  it("frames UTF-8 responses by bytes and keeps the next response aligned", async () => {
    const workspace = makeWorkspace();
    const client = await connectClient(workspace);

    const unicode = await client.callTool("__emit_unicode__", {}, 5_000);
    expect(unicode).toBe("graph — degraded → retry");

    // The control proves that consuming the multibyte frame did not eat bytes
    // from the next Content-Length header.
    const echoed = await client.callToolJson<{ cwd: string }>(
      "echo_cwd",
      {},
      10_000
    );
    expect(echoed.cwd).toBe(workspace);
  });

  it("retains a fragmented Content-Length header and keeps the next response aligned", async () => {
    const workspace = makeWorkspace();
    const client = await connectClient(workspace);

    const fragmentedPromise = client.callTool(
      "__emit_fragmented_header__",
      {},
      10_000
    );
    void fragmentedPromise.catch(() => undefined);

    const heldHeader = await waitForBufferedBytes(
      client,
      (bytes) =>
        /^Content-Length:\s*\d+\r\n$/i.test(bytes.toString("ascii")),
      "the partial Content-Length header",
    );
    expect(heldHeader.includes(Buffer.from("\r\n\r\n", "ascii"))).toBe(false);

    // The fixture releases the held bytes and a complete second response in
    // one fixture write. Both pending ids must dispatch from the stream.
    const releasePromise = client.callTool("__release_fragment__", {}, 10_000);
    const [fragmented, released] = await Promise.all([
      fragmentedPromise,
      releasePromise,
    ]);
    expect(fragmented).toBe("fragmented header survived");
    expect(released).toBe("fragment released");

    // A final control proves no partial header or payload remains afterward.
    const echoed = await client.callToolJson<{ cwd: string }>(
      "echo_cwd",
      {},
      5_000
    );
    expect(echoed.cwd).toBe(workspace);
  });

  it("retains a split UTF-8 code point and drains a coalesced next frame", async () => {
    const workspace = makeWorkspace();
    const client = await connectClient(workspace);

    const unicodePromise = client.callTool("__emit_split_unicode__", {}, 10_000);
    void unicodePromise.catch(() => undefined);

    const heldPayload = await waitForBufferedBytes(
      client,
      (bytes) => bytes.length > 0 && bytes[bytes.length - 1] === 0xe2,
      "the first byte of a split UTF-8 arrow",
    );
    expect(heldPayload.subarray(-1)).toEqual(Buffer.from([0xe2]));

    const releasePromise = client.callTool("__release_fragment__", {}, 10_000);
    const [unicode, released] = await Promise.all([
      unicodePromise,
      releasePromise,
    ]);
    expect(unicode).toBe("graph — degraded → retry");
    expect(released).toBe("fragment released");

    const echoed = await client.callToolJson<{ cwd: string }>(
      "echo_cwd",
      {},
      5_000,
    );
    expect(echoed.cwd).toBe(workspace);
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

  it("resolves graph-native search provenance through KinClient over the real transport", async () => {
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
  describe("isError results (real stdio transport)", () => {
    it("throws on an error result that carries NO content blocks", async () => {
      // The ordering bug. The empty-content shortcut used to run BEFORE the
      // isError check, so this exact shape returned "{}" and every parser above
      // read it as an empty graph rather than as a failed call.
      const client = await connectClient(makeWorkspace());
      await expect(
        client.callTool("__is_error_empty_content__", {})
      ).rejects.toThrow(McpToolError);
    });

    it("marks a warming error result as warming, carrying the server's text", async () => {
      const client = await connectClient(makeWorkspace());
      let caught: unknown;
      try {
        await client.callTool("__is_error_warming__", {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(McpToolError);
      const err = caught as McpToolError;
      expect(err.warming).toBe(true);
      expect(err.text).toContain("retry this call once the daemon is ready");
    });

    it("does not mark an ordinary error result as warming", async () => {
      // The control: an error with no warming language must stay a failure, or
      // every error becomes an infinite retry.
      const client = await connectClient(makeWorkspace());
      let caught: unknown;
      try {
        await client.callTool("__is_error_empty_content__", {});
      } catch (err) {
        caught = err;
      }
      expect((caught as McpToolError).warming).toBe(false);
    });
  });
});
