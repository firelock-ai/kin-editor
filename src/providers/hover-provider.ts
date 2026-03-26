// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "../kin-client";
import { logError } from "../logger";

export class KinHoverProvider implements vscode.HoverProvider {
  constructor(private client: KinClient) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range);
    if (!word || word.length < 2) {
      return undefined;
    }

    let related: KinEntity[];
    try {
      related = await this.client.traceQuick(word);
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
