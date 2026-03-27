// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// ARCHITECTURE NOTE: MCP-First with CLI Fallback
//
// This client routes queries through a persistent MCP connection to
// `kin mcp start` (zero-overhead tool calls over stdio). If the MCP
// connection is unavailable, it falls back to spawning a CLI subprocess
// per command via execFile().
//
// The MCP path is graph-first: queries go directly to the in-memory graph
// with no spawn overhead, no repeated graph loading, and support for
// server-initiated notifications in the future.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, sep } from "path";
import * as vscode from "vscode";
import { BinaryNotFoundError, TimeoutError, ParseError } from "./errors";
import { McpClient } from "./mcp-client";
import { log, logError } from "./logger";

export interface KinEntity {
  kind: string;
  name: string;
  file: string;
  line: number;
  signature?: string;
}

export interface KinStatus {
  initialized: boolean;
  entityCount: number;
  graphState: string;
}

export interface KinOverview {
  entities: number;
  edges: number;
  files: number;
  kinds: Record<string, number>;
}

export interface KinReviewFinding {
  entity: string;
  kind: string;
  file: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface KinReviewResult {
  file: string;
  findings: KinReviewFinding[];
  summary: string;
}

export interface KinRenameRange {
  startLine?: number;
  startCharacter?: number;
  startCol?: number;
  endLine?: number;
  endCharacter?: number;
  endCol?: number;
}

export interface KinRenameEdit {
  file: string;
  newText?: string;
  replacement?: string;
  text?: string;
  range?: KinRenameRange;
  startLine?: number;
  startCharacter?: number;
  startCol?: number;
  endLine?: number;
  endCharacter?: number;
  endCol?: number;
  line?: number;
  column?: number;
  character?: number;
}

export interface KinRenamePlan {
  entity: KinEntity | { name?: string; kind?: string; file?: string; line?: number };
  newName: string;
  edits: KinRenameEdit[];
  warnings: string[];
}

export class KinClient {
  private binaryPath: string | undefined;
  private workspacePath: string;
  private mcpClient: McpClient | null = null;

  constructor(workspacePath: string, mcpClient?: McpClient) {
    this.workspacePath = workspacePath;
    this.binaryPath = this.resolveBinary();
    this.mcpClient = mcpClient ?? null;
    log(`KinClient initialized — binary: ${this.binaryPath ?? "not found"}, mcp: ${mcpClient ? "provided" : "none"}`);
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /** Attach or replace the MCP client. */
  setMcpClient(client: McpClient | null): void {
    this.mcpClient = client;
  }

  /** Whether MCP is available for graph-first queries. */
  isMcpConnected(): boolean {
    return this.mcpClient?.isConnected() ?? false;
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

    // Fall back to PATH lookup — execFile resolves this safely
    // without invoking a shell (no injection risk).
    return "kin";
  }

  // ---------------------------------------------------------------------------
  // CLI subprocess fallback (unchanged from original)
  // ---------------------------------------------------------------------------

  private run(args: string[], timeoutMs: number = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.binaryPath) {
        reject(new BinaryNotFoundError());
        return;
      }

      execFile(
        this.binaryPath,
        args,
        { cwd: this.workspacePath, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed || error.signal === "SIGTERM") {
              reject(new TimeoutError(args.join(" "), timeoutMs));
              return;
            }
            if (
              "code" in error &&
              error.code === "ENOENT"
            ) {
              reject(new BinaryNotFoundError(this.binaryPath));
              return;
            }
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  private async runJson<T>(args: string[], timeoutMs?: number): Promise<T> {
    const raw = await this.run([...args, "--json"], timeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ParseError(
        args.join(" "),
        raw,
        err instanceof Error ? err : undefined
      );
    }

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as Record<string, unknown>).version === "number"
    ) {
      const outputVersion = (parsed as Record<string, unknown>).version as number;
      if (outputVersion > 1) {
        vscode.window.showWarningMessage(
          `Kin CLI output version ${outputVersion} is newer than this extension expects. ` +
          `Some features may not work correctly. Please update the Kin VS Code extension.`
        );
      }
    }

    return parsed as T;
  }

  private async runWithProgress<T>(
    label: string,
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    if (timeoutMs <= 2_000) {
      return fn();
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: label,
        cancellable: false,
      },
      () => fn()
    );
  }

  // ---------------------------------------------------------------------------
  // MCP-first query methods
  // ---------------------------------------------------------------------------

  async search(query: string): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "semantic_search",
          { query },
          15_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP search failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      "Kin: searching entities...",
      () => this.runJson<KinEntity[]>(["search", query], 15_000),
      15_000
    );
  }

  async entities(): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "explore_codebase",
          {},
          30_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP explore_codebase failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      "Kin: loading entities...",
      () => this.runJson<KinEntity[]>(["search", ""], 30_000),
      30_000
    );
  }

  async overview(): Promise<KinOverview> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "kin_graph_status",
          {},
          10_000,
        );
        return this.parseOverviewFromMcp(raw);
      } catch (err) {
        logError("MCP kin_graph_status failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      "Kin: loading overview...",
      () => this.runJson<KinOverview>(["overview"], 10_000),
      10_000
    );
  }

  async trace(entity: string): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "find_references",
          { entity_name: entity },
          10_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP find_references failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      `Kin: tracing ${entity}...`,
      () => this.runJson<KinEntity[]>(["trace", entity], 10_000),
      10_000
    );
  }

  async traceQuick(entity: string): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "find_references",
          { entity_name: entity },
          3_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch {
        // Silent fallback for quick queries
      }
    }
    return this.runJson<KinEntity[]>(["trace", entity], 3_000);
  }

  async status(): Promise<KinStatus> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "kin_graph_status",
          {},
          5_000,
        );
        return this.parseStatusFromMcp(raw);
      } catch {
        // Silent fallback
      }
    }
    try {
      return await this.runJson<KinStatus>(["status"], 5_000);
    } catch {
      return { initialized: false, entityCount: 0, graphState: "unknown" };
    }
  }

  async init(): Promise<string> {
    // init is always CLI — it creates the .kin/ directory
    return this.run(["init"]);
  }

  async review(filePath: string): Promise<KinReviewResult> {
    const relativePath = this.toRelativeWorkspacePath(filePath);
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "semantic_review",
          { files: [relativePath] },
          30_000,
        );
        return this.parseReviewFromMcp(raw, relativePath);
      } catch (err) {
        logError("MCP semantic_review failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      `Kin: reviewing ${relativePath}...`,
      () =>
        this.runJson<KinReviewResult>(["review", "--files", relativePath], 30_000),
      30_000
    );
  }

  async renamePlan(
    symbol: string,
    newName: string,
    filePath: string,
    line: number,
    column: number
  ): Promise<KinRenamePlan> {
    // Rename stays CLI for now — it requires the projection pipeline
    // which is not yet exposed as an MCP tool.
    const relativePath = this.toRelativeWorkspacePath(filePath);
    return this.runWithProgress(
      `Kin: planning rename for ${symbol}...`,
      () =>
        this.runJson<KinRenamePlan>(
          [
            "rename",
            symbol,
            newName,
            "--file",
            relativePath,
            "--line",
            String(line),
            "--column",
            String(column),
          ],
          30_000
        ),
      30_000
    );
  }

  isAvailable(): boolean {
    return this.binaryPath !== undefined || this.isMcpConnected();
  }

  // ---------------------------------------------------------------------------
  // MCP response parsers
  // ---------------------------------------------------------------------------

  /**
   * MCP tool results return text content. The text may be JSON (an array of
   * entities) or a human-readable table. We try JSON first, then attempt to
   * parse structured text.
   */
  private parseEntitiesFromMcp(raw: string): KinEntity[] {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(this.normalizeEntity);
      }
      // Some tools return { entities: [...] }
      if (parsed && Array.isArray(parsed.entities)) {
        return parsed.entities.map(this.normalizeEntity);
      }
      // Single entity
      if (parsed && typeof parsed.name === "string") {
        return [this.normalizeEntity(parsed)];
      }
      return [];
    } catch {
      // Not JSON — return empty (caller should fall back to CLI)
      return [];
    }
  }

  private normalizeEntity(raw: Record<string, unknown>): KinEntity {
    return {
      kind: String(raw.kind ?? raw.entity_kind ?? "Unknown"),
      name: String(raw.name ?? raw.entity_name ?? ""),
      file: String(raw.file ?? raw.file_path ?? ""),
      line: Number(raw.line ?? raw.start_line ?? 0),
      signature: raw.signature ? String(raw.signature) : undefined,
    };
  }

  private parseOverviewFromMcp(raw: string): KinOverview {
    try {
      const parsed = JSON.parse(raw);
      return {
        entities: Number(parsed.entity_count ?? parsed.entities ?? 0),
        edges: Number(parsed.edge_count ?? parsed.edges ?? 0),
        files: Number(parsed.file_count ?? parsed.files ?? 0),
        kinds: (parsed.kinds as Record<string, number>) ?? {},
      };
    } catch {
      return { entities: 0, edges: 0, files: 0, kinds: {} };
    }
  }

  private parseStatusFromMcp(raw: string): KinStatus {
    try {
      const parsed = JSON.parse(raw);
      return {
        initialized: true, // If MCP is running, repo is initialized
        entityCount: Number(parsed.entity_count ?? parsed.entities ?? 0),
        graphState: String(parsed.state ?? parsed.graph_state ?? "healthy"),
      };
    } catch {
      return { initialized: true, entityCount: 0, graphState: "unknown" };
    }
  }

  private parseReviewFromMcp(raw: string, filePath: string): KinReviewResult {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.findings && Array.isArray(parsed.findings)) {
        return {
          file: parsed.file ?? filePath,
          findings: parsed.findings,
          summary: parsed.summary ?? "",
        };
      }
      // Wrap text-only response
      return {
        file: filePath,
        findings: [],
        summary: typeof parsed === "string" ? parsed : raw,
      };
    } catch {
      return { file: filePath, findings: [], summary: raw };
    }
  }

  private toRelativeWorkspacePath(filePath: string): string {
    if (!filePath) {
      return filePath;
    }

    if (!isAbsolute(filePath)) {
      return filePath.split(sep).join("/");
    }

    const relativePath = relative(this.workspacePath, filePath);
    return relativePath.split(sep).join("/");
  }
}
