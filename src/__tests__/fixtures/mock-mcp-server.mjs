// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// A minimal MCP server (JSON-RPC 2.0 over stdio, Content-Length framed) used as
// a real subprocess stand-in for `kin mcp start` in the kin-editor live-path
// integration tests. It speaks the exact wire protocol McpClient implements —
// the initialize handshake, the `initialized` notification, and `tools/call` —
// and exposes deterministic tools plus explicit failure modes (non-JSON tool
// output, a protocol error, a crash) so the editor's handling can be proven
// beyond mocks without a real Kin daemon.
//
// This is test infrastructure. It is NOT the Kin graph engine and makes no
// semantic claims; validating the editor against the real `kin mcp start`
// binary is a separate, daemon-dependent step.

let buffer = "";

function send(msg) {
  const payload = JSON.stringify(msg);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
  );
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// MCP tools/call result shape: { content: [{ type: "text", text }] }.
function toolText(text) {
  return { content: [{ type: "text", text }] };
}

function handleToolCall(id, name) {
  switch (name) {
    case "kin_graph_status": {
      if (process.env.MOCK_MCP_INVALID_STATUS === "1") {
        // A valid JSON-RPC envelope whose graph-status text is NOT JSON.
        sendResult(id, toolText("garbled non-json status reply"));
        return;
      }
      const body =
        process.env.MOCK_MCP_EMPTY === "1"
          ? { entity_count: 0, edge_count: 0, file_count: 0, kinds: {} }
          : { entity_count: 3, edge_count: 2, file_count: 2, kinds: { Function: 2, Class: 1 } };
      sendResult(id, toolText(JSON.stringify(body)));
      return;
    }
    case "semantic_search":
    case "semantic_locate": {
      sendResult(
        id,
        toolText(
          JSON.stringify({
            results: [
              { kind: "Function", name: "handler", file_path: "src/handler.ts", start_line: 10 },
              { kind: "Class", name: "Server", file_path: "src/server.ts", start_line: 3 },
            ],
          })
        )
      );
      return;
    }
    case "find_references": {
      sendResult(
        id,
        toolText(
          JSON.stringify({
            references: [
              { kind: "Function", name: "caller", file_path: "src/caller.ts", start_line: 7 },
            ],
          })
        )
      );
      return;
    }
    case "echo_cwd": {
      // Proves which workspace the client connected to: McpClient spawns with
      // cwd = workspacePath, so process.cwd() here is that workspace.
      sendResult(id, toolText(JSON.stringify({ cwd: process.cwd() })));
      return;
    }
    case "__emit_non_json__": {
      // A well-formed JSON-RPC envelope whose tool text is NOT JSON — the exact
      // "broken/unavailable daemon reply looks like an empty graph" trap.
      sendResult(id, toolText("the daemon is still warming up, not json"));
      return;
    }
    case "__protocol_error__": {
      sendError(id, -32000, "simulated tool failure");
      return;
    }
    case "__crash__": {
      process.exit(1);
      return;
    }
    default: {
      sendError(id, -32601, `unknown tool: ${name}`);
      return;
    }
  }
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    sendResult(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp-server", version: "0.0.0" },
    });
    return;
  }
  if (msg.method === "initialized") {
    return; // notification — no response expected
  }
  if (msg.method === "tools/call") {
    handleToolCall(msg.id, msg.params?.name, msg.params?.arguments ?? {});
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    sendError(msg.id, -32601, `unknown method: ${msg.method}`);
  }
}

function drain() {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const payload = buffer.slice(start, start + length);
    buffer = buffer.slice(start + length);
    handleMessage(payload);
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  drain();
});
process.stdin.on("end", () => process.exit(0));
