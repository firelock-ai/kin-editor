// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";
import { log, logError } from "./logger";

/**
 * Notification method names sent by the kin daemon that signal a graph change.
 * Any of these cause the graph-changed event to fire so the UI can refresh.
 */
const GRAPH_CHANGE_NOTIFICATIONS = new Set([
  "kin/graphChanged",
  "kin/indexingComplete",
  "kin/reindexComplete",
  "$/progress",  // Some servers emit progress notifications at the end of indexing
]);

/** JSON-RPC 2.0 request. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool call result shape. */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * A tool call the server answered with `isError`. Carries the server's own text
 * so a caller can show it, and a `warming` flag so a caller can tell "ask me
 * again in a moment" apart from "this failed".
 */
export class McpToolError extends Error {
  readonly toolName: string;
  readonly text: string;
  readonly warming: boolean;

  constructor(toolName: string, text: string) {
    super(`MCP tool ${toolName} error: ${text}`);
    this.name = "McpToolError";
    this.toolName = toolName;
    this.text = text;
    this.warming = isWarmingText(text);
  }
}

/**
 * Phrases `kin mcp start` uses when the transport is up but the repo daemon has
 * not finished starting. Measured verbatim from a cold `kin 0.6.0` daemon; the
 * captured reply is checked in at `src/__tests__/fixtures/mcp/warming.json`.
 *
 * This is a text signal, which is not something to be happy about, but the
 * server publishes no structured code for the condition and the alternative is
 * treating "retry me" as "there is nothing here". Any one marker is enough, so
 * a reworded sentence has to lose all of them before the signal is lost, and
 * the negative control in the tests is a genuine error that must not match.
 */
const WARMING_MARKERS = [
  "is still starting",
  "retry this call once the daemon is ready",
  "startup latency, not a failure",
];

export function isWarmingText(text: string): boolean {
  const haystack = text.toLowerCase();
  return WARMING_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

/** Pending request awaiting a response. */
interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 notification (no id field).
 * The server sends these without expecting a response.
 */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** Construction options for {@link McpClient}. */
export interface McpClientOptions {
  /** Default per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Override the spawned process. Defaults to the resolved kin binary with
   * `["mcp", "start"]`. Tests inject a fixture MCP server here to exercise the
   * real stdio/JSON-RPC transport without a live Kin daemon.
   */
  spawn?: { command: string; args: string[] };
}

/**
 * Persistent MCP client that communicates with `kin mcp start` over stdio.
 *
 * Protocol: JSON-RPC 2.0 with Content-Length framing (standard MCP).
 * Lifecycle: spawn on connect(), kill on dispose(). Auto-reconnect on crash.
 */
export class McpClient implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  // Content-Length is measured in bytes, so keep framing state as bytes until
  // one complete payload is available. Decoding chunks first makes UTF-8 byte
  // offsets diverge from JavaScript string offsets.
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly binaryPath: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly spawnOverride: { command: string; args: string[] } | undefined;

  /**
   * Fires whenever the daemon sends a graph-change notification
   * (e.g. after a re-index). Subscribers should refresh their UI.
   */
  private readonly _onGraphChanged = new vscode.EventEmitter<void>();
  readonly onGraphChanged: vscode.Event<void> = this._onGraphChanged.event;

  constructor(
    private workspacePath: string,
    options: McpClientOptions = {},
  ) {
    this.defaultTimeoutMs = options.timeoutMs ?? 15_000;
    this.spawnOverride = options.spawn;
    this.binaryPath = this.resolveBinary();
  }

  private resolveBinary(): string | undefined {
    const config = vscode.workspace.getConfiguration("kin");
    const configured = config.get<string>("binaryPath");
    if (configured && existsSync(configured)) {
      return configured;
    }
    const homeBin = join(homedir(), ".kin", "bin", "kin");
    if (existsSync(homeBin)) {
      return homeBin;
    }
    return "kin";
  }

  /** Whether the MCP connection is live and initialized. */
  isConnected(): boolean {
    return this.initialized && this.process !== null && !this.disposed;
  }

  /** Spawn the MCP server process and perform the initialize handshake. */
  async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.spawnOverride && !this.binaryPath) {
      log("MCP: no kin binary found, skipping connection");
      return;
    }

    try {
      this.spawnProcess();
      await this.handshake();
      this.initialized = true;
      log(`MCP: connected to kin mcp in ${this.workspacePath}`);
    } catch (err) {
      logError("MCP: connection failed", err);
      this.killProcess();
    }
  }

  private spawnProcess(): void {
    this.killProcess();

    const { command, args } = this.spawnOverride ?? {
      command: this.binaryPath!,
      args: ["mcp", "start"],
    };
    const proc = spawn(command, args, {
      cwd: this.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    proc.on("error", (err) => {
      logError("MCP: process error", err);
      this.handleProcessExit();
    });

    proc.on("exit", (code, signal) => {
      log(`MCP: process exited (code=${code}, signal=${signal})`);
      this.handleProcessExit();
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        log(`MCP stderr: ${text}`);
      }
    });

    this.process = proc;
  }

  private handleProcessExit(): void {
    this.initialized = false;
    this.process = null;
    this.rejectAllPending("MCP process exited");

    if (!this.disposed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    log("MCP: scheduling reconnect in 5s");
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (!this.disposed) {
        await this.connect();
      }
    }, 5_000);
  }

  private killProcess(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
    this.initialized = false;
    this.buffer = Buffer.alloc(0);
    this.rejectAllPending("MCP process killed");
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Parse incoming data using Content-Length framing.
   * The MCP server sends: `Content-Length: N\r\n\r\n{json payload}`
   */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drainBuffer();
  }

  private drainBuffer(): void {
    for (;;) {
      // Try Content-Length framing first
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const headerBlock = this.buffer
          .subarray(0, headerEnd)
          .toString("ascii");
        const contentLengthMatch = headerBlock.match(
          /Content-Length:\s*(\d+)/i,
        );
        if (contentLengthMatch) {
          const contentLength = parseInt(contentLengthMatch[1], 10);
          const payloadStart = headerEnd + 4;
          if (this.buffer.length >= payloadStart + contentLength) {
            const payloadEnd = payloadStart + contentLength;
            const payload = this.buffer
              .subarray(payloadStart, payloadEnd)
              .toString("utf-8");
            this.buffer = this.buffer.subarray(payloadEnd);
            this.handleMessage(payload);
            continue;
          }
          // Not enough data yet for the payload
          break;
        }
      }

      // Try bare newline-delimited JSON as fallback
      const newlineIdx = this.buffer.indexOf(0x0a);
      if (newlineIdx !== -1) {
        const line = this.buffer
          .subarray(0, newlineIdx)
          .toString("utf-8")
          .trim();

        // A Content-Length header can be split immediately after its first
        // CRLF. Retain that partial header until the blank line and payload
        // arrive rather than treating it as non-JSON fallback output.
        if (headerEnd === -1 && /^Content-Length:\s*\d+$/i.test(line)) {
          break;
        }

        this.buffer = this.buffer.subarray(newlineIdx + 1);
        if (line.length > 0 && line.startsWith("{")) {
          this.handleMessage(line);
          continue;
        }
        // Skip non-JSON lines (e.g., empty lines, log output)
        continue;
      }

      break;
    }
  }

  private handleMessage(raw: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(raw);
    } catch {
      logError("MCP: failed to parse response", new Error(raw.slice(0, 200)));
      return;
    }

    if (response.id == null) {
      // Server-initiated notification (no id field in JSON-RPC).
      // Check whether this signals a graph change so we can refresh the UI.
      const notification = response as unknown as JsonRpcNotification;
      if (GRAPH_CHANGE_NOTIFICATIONS.has(notification.method)) {
        log(`MCP: graph-change notification received (${notification.method})`);
        this._onGraphChanged.fire();
      }
      return;
    }

    const pending = this.pending.get(response.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  /** Send a JSON-RPC request and wait for the response. */
  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin?.writable) {
        reject(new Error("MCP process not running"));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timeout = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request);
      const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;

      this.process.stdin!.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Perform the MCP initialize handshake. */
  private async handshake(): Promise<void> {
    const response = await this.sendRequest(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "kin-editor",
          version: "0.1.9",
        },
      },
      10_000,
    );

    if (response.error) {
      throw new Error(
        `MCP initialize failed: ${response.error.message}`,
      );
    }

    // Send initialized notification (no id = notification, no response expected)
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    const frame = `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`;
    this.process?.stdin?.write(frame);

    log(
      `MCP: initialized (server: ${JSON.stringify((response.result as Record<string, unknown>)?.serverInfo)})`,
    );
  }

  /**
   * Call an MCP tool by name.
   *
   * @returns The parsed text content from the first content block, or throws.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<string> {
    if (!this.isConnected()) {
      throw new Error("MCP not connected");
    }

    const response = await this.sendRequest(
      "tools/call",
      { name: toolName, arguments: args },
      timeoutMs,
    );

    if (response.error) {
      throw new Error(
        `MCP tool ${toolName} failed: ${response.error.message}`,
      );
    }

    const result = response.result as McpToolResult | undefined;

    // `isError` is read BEFORE the empty-content shortcut below. The other
    // order let an error result with no content blocks return "{}", which every
    // parser above reads as an empty answer, so a failed call was
    // indistinguishable from a graph with nothing in it.
    if (result?.isError) {
      const errorText = (result.content ?? []).map((c) => c.text).join("\n");
      throw new McpToolError(toolName, errorText || "(no detail)");
    }

    if (!result || !result.content || result.content.length === 0) {
      return "{}";
    }

    return result.content.map((c) => c.text).join("\n");
  }

  /**
   * Call an MCP tool and parse the text content as JSON.
   */
  async callToolJson<T>(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const text = await this.callTool(toolName, args, timeoutMs);
    return JSON.parse(text) as T;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.killProcess();
    this._onGraphChanged.dispose();
  }
}
