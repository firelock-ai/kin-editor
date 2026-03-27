// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinEntity } from "../kin-client";
import { WorkspaceManager } from "../workspace-manager";

const HOVER_DEBOUNCE_MS = 300;

export class KinHoverProvider implements vscode.HoverProvider {
  private hoverTimeout: ReturnType<typeof setTimeout> | undefined;
  private hoverResolve: ((value: vscode.Hover | undefined) => void) | undefined;

  constructor(private manager: WorkspaceManager) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    return new Promise((resolve) => {
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
      }
      if (this.hoverResolve) {
        this.hoverResolve(undefined);
      }
      this.hoverResolve = resolve;
      this.hoverTimeout = setTimeout(async () => {
        const result = await this.doProvideHover(document, position);
        resolve(result);
      }, HOVER_DEBOUNCE_MS);
    });
  }

  private async doProvideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range);
    if (!word || word.length < 2) {
      return undefined;
    }

    const client = this.manager.getClientForPath(document.uri.fsPath);
    if (!client) {
      return undefined;
    }

    let related: KinEntity[];
    try {
      related = await client.traceQuick(word);
    } catch {
      // Timeout or binary issue — don't block the editor
      return undefined;
    }

    if (related.length === 0) {
      return undefined;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    // Show the primary entity (first result matching the word)
    const primary = related.find(
      (e) => e.name === word || e.name.endsWith(`.${word}`)
    );

    if (primary) {
      md.appendMarkdown(`**${primary.kind}** \`${primary.name}\`\n\n`);
      md.appendMarkdown(`$(file) \`${primary.file}:${primary.line}\`\n\n`);
      if (primary.signature) {
        md.appendCodeblock(primary.signature, inferLanguage(primary.file));
      }

      // Show related entities (excluding the primary)
      const others = related.filter((e) => e !== primary);
      if (others.length > 0) {
        md.appendMarkdown(`\n---\n**Related entities** (${others.length})\n\n`);
        for (const e of others.slice(0, 8)) {
          md.appendMarkdown(
            `- \`${e.kind}\` **${e.name}** — \`${e.file}:${e.line}\`\n`
          );
        }
        if (others.length > 8) {
          md.appendMarkdown(
            `\n*...and ${others.length - 8} more (use Kin Trace for full list)*\n`
          );
        }
      }
    } else {
      // No exact match — just show all related
      md.appendMarkdown(`**Kin: ${related.length} related entity(ies) for** \`${word}\`\n\n`);
      for (const e of related.slice(0, 8)) {
        md.appendMarkdown(
          `- \`${e.kind}\` **${e.name}** — \`${e.file}:${e.line}\`\n`
        );
      }
      if (related.length > 8) {
        md.appendMarkdown(
          `\n*...and ${related.length - 8} more*\n`
        );
      }
    }

    return new vscode.Hover(md, range);
  }
}

function inferLanguage(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    cs: "csharp",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
  };
  return map[ext ?? ""] || "";
}
