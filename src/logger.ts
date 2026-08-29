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

/**
 * Reveal the Kin output channel.
 *
 * The streamed `kin init` writes the CLI's own words here, so every surface
 * that quotes one line of them needs a way to show the user the rest.
 */
export function showLog(): void {
  channel?.show(true);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  channel?.appendLine(`[${timestamp()}] ERROR: ${msg}${detail ? ": " + detail : ""}`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}
