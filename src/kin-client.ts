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
import {
  BinaryNotFoundError,
  CliContractError,
  TimeoutError,
  ParseError,
} from "./errors";
import { McpClient } from "./mcp-client";
import { log, logError } from "./logger";
import {
  ContractDrift,
  ContractNote,
  ContractResult,
  describeDrift,
  describeNote,
  driftKey,
  noteKey,
  normalizeEntity,
  normalizeReviewFinding,
  readEntities,
  readOverview,
  readReview,
  readStatus,
} from "./cli-contract";

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
  /**
   * False when neither the MCP graph path nor the CLI answered at all. In that
   * case `initialized` is a failed probe rather than a real answer, and the UI
   * must say the runtime could not be reached instead of telling a user with a
   * perfectly good `.kin/` directory to initialize the repository again.
   * Undefined on a status that predates this distinction.
   */
  reachable?: boolean;
  /**
   * Set when the CLI answered but in a shape this extension cannot read. That
   * is neither "unreachable" nor "not initialized": the runtime is healthy and
   * the two versions have drifted, so the UI must say so rather than send the
   * user to `kin init` on a repository that is already initialized.
   */
  contractDrift?: {
    command: string;
    missing: readonly string[];
    schema?: string;
  };
}

/**
 * Fine-grained graph availability so the UI can distinguish an empty graph
 * from an unreachable daemon, a garbled/unparseable response, or a workspace
 * that simply has not been indexed yet — instead of collapsing every non-happy
 * path into a single "not indexed" or empty state.
 */
export type GraphAvailability =
  | "indexed" // a real graph response with entities
  | "empty" // graph reachable, but zero entities yet
  | "not-indexed" // reachable, but this workspace is not indexed yet
  | "unavailable" // the daemon / binary could not be reached
  | "invalid-response" // a response arrived but could not be parsed as graph data
  | "contract-drift"; // a valid response arrived in a shape this extension cannot read

export interface KinOverview {
  entities: number;
  edges: number;
  files: number;
  kinds: Record<string, number>;
  /**
   * Back-compat convenience: true iff {@link availability} is "indexed".
   * Prefer `availability` for user-facing messaging.
   */
  indexed: boolean;
  /** Fine-grained graph state — see {@link GraphAvailability}. */
  availability: GraphAvailability;
  /**
   * True when the MCP graph path was expected (an MCP client was connected) but
   * a call failed and the CLI compatibility path answered instead — a partial /
   * degraded state the UI should surface, not hide.
   */
  compatFallback: boolean;
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

type UnknownRecord = Record<string, unknown>;

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

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

const QUICK_TRACE_CACHE_TTL_MS = 5_000;

interface QuickTraceCacheEntry {
  expiresAt: number;
  promise: Promise<KinEntity[]>;
}

export class KinClient {
  private binaryPath: string | undefined;
  private workspacePath: string;
  private mcpClient: McpClient | null = null;

  /**
   * Short-lived cache for traceQuick used by hover and go-to-definition.
   * Coalesces concurrent identical lookups and reuses results within a TTL so
   * repeated hovers / clicks on the same word do not fan out one subprocess
   * (or MCP round-trip) per word.
   */
  private quickTraceCache = new Map<string, QuickTraceCacheEntry>();

  /** Contract drifts and schema notes already shown, so each is shown once. */
  private reportedContractIssues = new Set<string>();

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

  /**
   * Run a `kin <command> --json` call and read it through its declared
   * contract.
   *
   * The contract check replaces a guard that could never fire. The old one
   * warned only when the parsed object carried a numeric top-level `version`,
   * and no `kin` release this extension has been measured against publishes
   * one: `kin 0.6.0`'s status output has no `version` key at all. So the one
   * mechanism built to catch CLI drift was structurally silent on exactly the
   * drift it existed for, and a drifted answer reached the panes as a set of
   * `undefined` reads that render as a confident empty graph.
   *
   * A reader that cannot use the answer now throws, and the user gets one
   * warning naming the command and the missing keys.
   */
  private async runJson<T>(
    args: string[],
    read: (parsed: unknown) => ContractResult<T>,
    timeoutMs?: number
  ): Promise<T> {
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

    const result = read(parsed);
    if (!result.ok) {
      this.reportDrift(result);
      throw new CliContractError(
        result.command,
        result.missing,
        describeDrift(result),
        result.schema
      );
    }

    if (result.note) {
      this.reportNote(result.note);
    }
    return result.value;
  }

  /**
   * Surface a drift once per session per distinct cause. A user running a
   * command in a loop against a drifted CLI should see the warning, not a
   * notification storm that trains them to dismiss it.
   */
  private reportDrift(drift: ContractDrift): void {
    const message = describeDrift(drift);
    logError(`Kin CLI contract drift on ${drift.command}`, new Error(message));
    this.showOnce(driftKey(drift), message);
  }

  private reportNote(note: ContractNote): void {
    this.showOnce(noteKey(note), describeNote(note));
  }

  /**
   * Show a message once per session. Notification failures are swallowed on
   * purpose: the caller is mid-diagnosis, and letting a failed notification
   * throw would replace a precise "the CLI contract drifted" with whatever the
   * UI threw, which the caller would then report as an unreachable runtime.
   */
  private showOnce(key: string, message: string): void {
    if (this.reportedContractIssues.has(key)) {
      return;
    }
    this.reportedContractIssues.add(key);
    try {
      vscode.window.showWarningMessage(message);
    } catch (err) {
      logError("Failed to surface a Kin CLI contract warning", err);
    }
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

  /**
   * Semantic search: routes to `semantic_locate` (vector / natural-language
   * retrieval) when MCP is available, falling back to the CLI `kin search`
   * command. Use this for the user-facing "Kin: Semantic Search" command.
   *
   * `semantic_search` (name-pattern substring) is used by
   * `symbolSearch` below for the workspace symbol provider (Cmd+T), where
   * VS Code expects name-filtering behaviour.
   */
  async search(query: string): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "semantic_locate",
          { query, limit: 50, granularity: "entity" },
          15_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP semantic_locate failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      "Kin: searching entities...",
      () => this.runJson(["search", query], (raw) => readEntities("search", raw), 15_000),
      15_000
    );
  }

  /**
   * Name-pattern search: routes to `semantic_search` (substring / name
   * matching) when MCP is available.  Used by the workspace symbol provider
   * (Cmd+T / Ctrl+T) where VS Code expects results filtered by the typed
   * identifier prefix.
   */
  async symbolSearch(query: string): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "semantic_search",
          { query, limit: 50, compact: true },
          15_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP semantic_search failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      "Kin: searching symbols...",
      () => this.runJson(["search", query], (raw) => readEntities("search", raw), 15_000),
      15_000
    );
  }

  async entities(): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "semantic_search",
          { query: "", limit: 5000, compact: true },
          30_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP entity load failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      "Kin: loading entities...",
      () => this.runJson(["search", ""], (raw) => readEntities("search", raw), 30_000),
      30_000
    );
  }

  async overview(): Promise<KinOverview> {
    const mcpWasConnected = this.isMcpConnected();
    if (mcpWasConnected) {
      try {
        const raw = await this.mcpClient!.callTool(
          "kin_graph_status",
          {},
          10_000,
        );
        return this.parseOverviewFromMcp(raw);
      } catch (err) {
        logError("MCP kin_graph_status failed, falling back to CLI", err);
        // Degrade to the CLI compatibility path below.
      }
    }
    try {
      const cliOverview = await this.runWithProgress(
        "Kin: loading overview...",
        () => this.runJson(["overview"], readOverview, 10_000),
        10_000
      );
      return { ...cliOverview, compatFallback: mcpWasConnected };
    } catch (err) {
      // The CLI answered in a shape this extension cannot read. That is not an
      // unreachable graph, and calling it one sends the user to a remedy that
      // cannot help. Give the drift its own state.
      if (err instanceof CliContractError) {
        return {
          entities: 0,
          edges: 0,
          files: 0,
          kinds: {},
          indexed: false,
          availability: "contract-drift",
          compatFallback: mcpWasConnected,
        };
      }
      // Both the MCP graph path and the CLI compatibility path failed — the
      // graph is unavailable. Report that honestly rather than a fabricated
      // empty overview.
      logError("Kin overview failed on both MCP and CLI paths", err);
      return {
        entities: 0,
        edges: 0,
        files: 0,
        kinds: {},
        indexed: false,
        availability: "unavailable",
        compatFallback: mcpWasConnected,
      };
    }
  }

  async trace(entity: string): Promise<KinEntity[]> {
    if (this.isMcpConnected()) {
      try {
        const raw = await this.mcpClient!.callTool(
          "find_references",
          { query: entity },
          10_000,
        );
        return this.parseEntitiesFromMcp(raw);
      } catch (err) {
        logError("MCP find_references failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      `Kin: tracing ${entity}...`,
      () => this.runJson(["trace", entity], (raw) => readEntities("trace", raw), 10_000),
      10_000
    );
  }

  async traceQuick(entity: string): Promise<KinEntity[]> {
    const now = Date.now();
    const cached = this.quickTraceCache.get(entity);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const promise = this.runQuickTrace(entity);
    this.quickTraceCache.set(entity, {
      expiresAt: now + QUICK_TRACE_CACHE_TTL_MS,
      promise,
    });
    promise.catch(() => {
      const current = this.quickTraceCache.get(entity);
      if (current && current.promise === promise) {
        this.quickTraceCache.delete(entity);
      }
    });
    return promise;
  }

  /**
   * Hover and go-to-definition run on every word the cursor touches, so this
   * path is MCP-only on purpose. A CLI fallback here would spawn one subprocess
   * per hover. With `kin.mcpEnabled` off, or before the MCP connection is live,
   * it returns nothing and those two features stay quiet.
   */
  private async runQuickTrace(entity: string): Promise<KinEntity[]> {
    if (!this.isMcpConnected()) {
      return [];
    }
    try {
      const raw = await this.mcpClient!.callTool(
        "find_references",
        { query: entity },
        3_000,
      );
      return this.parseEntitiesFromMcp(raw);
    } catch {
      return [];
    }
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
      } catch (err) {
        logError("MCP kin_graph_status failed, falling back to CLI", err);
      }
    }
    try {
      return await this.runJson(["status"], readStatus, 5_000);
    } catch (err) {
      // The CLI ran, exited 0 and emitted valid JSON in a shape this extension
      // cannot read. The runtime is reachable and the repository is almost
      // certainly initialized, so reporting either the reverse would be a
      // fabrication. Say what is actually true: the versions have drifted.
      if (err instanceof CliContractError) {
        return {
          initialized: false,
          entityCount: 0,
          graphState: "contract drift",
          reachable: true,
          contractDrift: {
            command: err.command,
            missing: err.missing,
            ...(err.schema ? { schema: err.schema } : {}),
          },
        };
      }
      // Both paths failed. Report that as unreachable rather than collapsing it
      // into "not initialized", which sends the user to a remedy that cannot
      // help them.
      logError("Kin status failed on both MCP and CLI paths", err);
      return {
        initialized: false,
        entityCount: 0,
        graphState: "unknown",
        reachable: false,
      };
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
          { files: [relativePath], include_traffic: false, format: "json" },
          30_000,
        );
        const review = this.parseReviewFromMcp(raw, relativePath);
        if (review) {
          return review;
        }
        throw new Error("MCP semantic_review returned unstructured text");
      } catch (err) {
        logError("MCP semantic_review failed, falling back to CLI", err);
      }
    }
    return this.runWithProgress(
      `Kin: reviewing ${relativePath}...`,
      () =>
        this.runJson(
          ["review", "--files", relativePath],
          (raw) => readReview(raw, relativePath),
          30_000
        ),
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
    //
    // It also carries no contract check, on purpose. `kin rename --json` was
    // measured against kin 0.6.0 on two freshly initialized repositories, one
    // Python and one TypeScript, and it refused both with HTTP 409 and an empty
    // stdout: the graph source carried an extraction-incomplete certificate on
    // one and an out-of-range span on the other. So there is no observed
    // success payload to write a contract from, and a contract invented from
    // the reader's own type would assert nothing about the CLI. This path also
    // fails loudly rather than silently — a nonzero exit with an empty stdout
    // rejects through `run()` and reaches the user as an error message — which
    // is the failure mode the contract layer exists to create, not to prevent.
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
          (raw) => ({ ok: true, value: raw as KinRenamePlan }),
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
        return parsed.map(normalizeEntity);
      }

      if (!this.isRecord(parsed)) {
        return [];
      }

      for (const key of ["results", "entities", "references"]) {
        const value = parsed[key];
        if (Array.isArray(value)) {
          return value.map(normalizeEntity).filter((entity) => entity.name || entity.file);
        }
      }

      if (this.isRecord(parsed.focal_entity)) {
        return [normalizeEntity(parsed.focal_entity)];
      }
      if (typeof parsed.name === "string") {
        return [normalizeEntity(parsed)];
      }
      return [];
    } catch {
      // Not JSON — return empty (caller should fall back to CLI)
      return [];
    }
  }

  private parseOverviewFromMcp(raw: string): KinOverview {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A response arrived but is not JSON. This is a broken / still-warming
      // daemon reply, NOT an empty graph — surface it as invalid so the UI
      // never presents a garbled response as "0 entities".
      return {
        entities: 0,
        edges: 0,
        files: 0,
        kinds: {},
        indexed: false,
        availability: "invalid-response",
        compatFallback: false,
      };
    }
    if (!this.isRecord(parsed)) {
      return {
        entities: 0,
        edges: 0,
        files: 0,
        kinds: {},
        indexed: false,
        availability: "invalid-response",
        compatFallback: false,
      };
    }
    const entities = Number(parsed.entity_count ?? parsed.entities ?? 0);
    return {
      entities,
      edges: Number(parsed.edge_count ?? parsed.edges ?? 0),
      files: Number(parsed.file_count ?? parsed.files ?? 0),
      kinds: (parsed.kinds as Record<string, number>) ?? {},
      indexed: entities > 0,
      availability: entities > 0 ? "indexed" : "empty",
      compatFallback: false,
    };
  }

  private parseStatusFromMcp(raw: string): KinStatus {
    try {
      const parsed = JSON.parse(raw);
      return {
        initialized: true, // If MCP is running, repo is initialized
        entityCount: Number(parsed.entity_count ?? parsed.entities ?? 0),
        graphState: String(parsed.state ?? parsed.graph_state ?? "healthy"),
        reachable: true,
      };
    } catch {
      return {
        initialized: true,
        entityCount: 0,
        graphState: "unknown",
        reachable: true,
      };
    }
  }

  private parseReviewFromMcp(raw: string, filePath: string): KinReviewResult | undefined {
    try {
      const parsed = JSON.parse(raw);
      if (!this.isRecord(parsed)) {
        return undefined;
      }

      if (Array.isArray(parsed.findings)) {
        return {
          file: String(parsed.file ?? filePath),
          findings: parsed.findings.map((finding) =>
            normalizeReviewFinding(asRecord(finding), filePath)
          ),
          summary: String(parsed.summary ?? ""),
        };
      }

      if (Array.isArray(parsed.inline_comments)) {
        return {
          file: filePath,
          findings: parsed.inline_comments.map((comment) =>
            this.normalizeInlineComment(comment, filePath)
          ),
          summary: this.reviewSummary(parsed),
        };
      }

      if (typeof parsed.summary === "string") {
        return {
          file: filePath,
          findings: [],
          summary: parsed.summary,
        };
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeInlineComment(raw: unknown, fallbackFile: string): KinReviewFinding {
    const comment = this.isRecord(raw) ? raw : {};
    return {
      entity: "",
      kind: String(comment.kind ?? "Review"),
      file: String(comment.file ?? fallbackFile),
      line: Number(comment.start_line ?? comment.line ?? 1),
      severity: this.inlineCommentSeverity(comment.kind),
      message: String(comment.message ?? ""),
    };
  }

  private inlineCommentSeverity(kind: unknown): KinReviewFinding["severity"] {
    switch (String(kind)) {
      case "Breaking":
      case "ContractViolation":
        return "error";
      case "CoverageGap":
      case "SignatureChange":
      case "VisibilityChange":
      case "AgentUnreviewed":
        return "warning";
      default:
        return "info";
    }
  }

  private reviewSummary(parsed: UnknownRecord): string {
    if (typeof parsed.summary === "string") {
      return parsed.summary;
    }
    if (this.isRecord(parsed.risk)) {
      const risk = parsed.risk;
      const level = risk.overall_risk ?? risk.overallRisk;
      if (level) {
        return `Risk: ${String(level)}`;
      }
    }
    return "";
  }

  private isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
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
