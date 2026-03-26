// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, sep } from "path";
import * as vscode from "vscode";
import { BinaryNotFoundError, TimeoutError, ParseError } from "./errors";
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

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.binaryPath = this.resolveBinary();
    log(`KinClient initialized — binary: ${this.binaryPath ?? "not found"}`);
  }

  getWorkspacePath(): string {
    return this.workspacePath;
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

  /**
   * Execute the kin binary with the given arguments.
   * Uses execFile (NOT exec) to avoid shell injection.
   * @param args CLI arguments
   * @param timeoutMs per-command timeout in milliseconds (default 10s)
   */
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
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new ParseError(
        args.join(" "),
        raw,
        err instanceof Error ? err : undefined
      );
    }
  }

  /**
   * Run a command with vscode.window.withProgress if the timeout
   * suggests it could be a long operation (>2s).
   */
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

  async search(query: string): Promise<KinEntity[]> {
    return this.runWithProgress(
      "Kin: searching entities...",
      () => this.runJson<KinEntity[]>(["search", query], 15_000),
      15_000
    );
  }

  async entities(): Promise<KinEntity[]> {
    return this.runWithProgress(
      "Kin: loading entities...",
      () => this.runJson<KinEntity[]>(["search", ""], 30_000),
      30_000
    );
  }

  async overview(): Promise<KinOverview> {
    return this.runWithProgress(
      "Kin: loading overview...",
      () => this.runJson<KinOverview>(["overview"], 10_000),
      10_000
    );
  }

  async trace(entity: string): Promise<KinEntity[]> {
    return this.runWithProgress(
      `Kin: tracing ${entity}...`,
      () => this.runJson<KinEntity[]>(["trace", entity], 10_000),
      10_000
    );
  }

  /**
   * Quick trace with a short timeout — used by hover provider
   * where latency matters more than completeness.
   */
  async traceQuick(entity: string): Promise<KinEntity[]> {
    return this.runJson<KinEntity[]>(["trace", entity], 3_000);
  }

  async status(): Promise<KinStatus> {
    try {
      return await this.runJson<KinStatus>(["status"], 5_000);
    } catch {
      return { initialized: false, entityCount: 0, graphState: "unknown" };
    }
  }

  async init(): Promise<string> {
    return this.run(["init"]);
  }

  async review(filePath: string): Promise<{
    file: string;
    findings: KinReviewFinding[];
    summary: string;
  }> {
    const relativePath = this.toRelativeWorkspacePath(filePath);
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
    return this.binaryPath !== undefined;
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
