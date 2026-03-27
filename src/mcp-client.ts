// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";
import { log, logError } from "./logger";

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

/** Pending request awaiting a response. */
interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private buffer = "";
  private initialized = false;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly binaryPath: string | undefined;

  constructor(
    private workspacePath: string,
    private readonly defaultTimeoutMs: number = 15_000,
  ) {
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
    if (!this.binaryPath) {
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

    const proc = spawn(this.binaryPath!, ["mcp", "start"], {
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
      this.onData(chunk.toString("utf-8"));
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
    this.buffer = "";
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
  private onData(chunk: string): void {
    this.buffer += chunk;
    this.drainBuffer();
  }

  private drainBuffer(): void {
    for (;;) {
      // Try Content-Length framing first
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const headerBlock = this.buffer.slice(0, headerEnd);
        const contentLengthMatch = headerBlock.match(
          /Content-Length:\s*(\d+)/i,
        );
        if (contentLengthMatch) {
          const contentLength = parseInt(contentLengthMatch[1], 10);
          const payloadStart = headerEnd + 4;
          if (this.buffer.length >= payloadStart + contentLength) {
            const payload = this.buffer.slice(
              payloadStart,
              payloadStart + contentLength,
            );
            this.buffer = this.buffer.slice(payloadStart + contentLength);
            this.handleMessage(payload);
            continue;
          }
          // Not enough data yet for the payload
          break;
        }
      }

      // Try bare newline-delimited JSON as fallback
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
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
      // Notification — ignore for now
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
          version: "0.1.0",
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
    if (!result || !result.content || result.content.length === 0) {
      return "{}";
    }

    if (result.isError) {
      const errorText = result.content
        .map((c) => c.text)
        .join("\n");
      throw new Error(`MCP tool ${toolName} error: ${errorText}`);
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
  }
}
