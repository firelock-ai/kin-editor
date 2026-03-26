// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Kin");
  }
  return channel;
}

export function log(msg: string): void {
  channel?.appendLine(`[${timestamp()}] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  channel?.appendLine(`[${timestamp()}] ERROR: ${msg}${detail ? " — " + detail : ""}`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}
