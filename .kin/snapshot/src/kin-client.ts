// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";

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

export class KinClient {
  private binaryPath: string | undefined;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
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

    // Fall back to PATH lookup — execFile resolves this safely
    // without invoking a shell (no injection risk).
    return "kin";
  }

  /**
   * Execute the kin binary with the given arguments.
   * Uses execFile (NOT exec) to avoid shell injection.
   */
  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.binaryPath) {
        reject(new Error("Kin binary not found"));
        return;
      }

      execFile(
        this.binaryPath,
        args,
        { cwd: this.workspacePath, timeout: 10_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const raw = await this.run([...args, "--json"]);
    return JSON.parse(raw) as T;
  }

  async search(query: string): Promise<KinEntity[]> {
    return this.runJson<KinEntity[]>(["search", query]);
  }

  async entities(): Promise<KinEntity[]> {
    return this.runJson<KinEntity[]>(["search", ""]);
  }

  async overview(): Promise<KinOverview> {
    return this.runJson<KinOverview>(["overview"]);
  }

  async trace(entity: string): Promise<KinEntity[]> {
    return this.runJson<KinEntity[]>(["trace", entity]);
  }

  async status(): Promise<KinStatus> {
    try {
      return await this.runJson<KinStatus>(["status"]);
    } catch {
      return { initialized: false, entityCount: 0, graphState: "unknown" };
    }
  }

  async init(): Promise<string> {
    return this.run(["init"]);
  }

  isAvailable(): boolean {
    return this.binaryPath !== undefined;
  }
}
