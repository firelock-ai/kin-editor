// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "../kin-client";
import { WorkspaceManager } from "../workspace-manager";
import { logError } from "../logger";
import { join } from "path";

const KIND_MAP: Record<string, vscode.SymbolKind> = {
  Function: vscode.SymbolKind.Function,
  Method: vscode.SymbolKind.Method,
  Class: vscode.SymbolKind.Class,
  Struct: vscode.SymbolKind.Struct,
  Interface: vscode.SymbolKind.Interface,
  Enum: vscode.SymbolKind.Enum,
  Module: vscode.SymbolKind.Module,
  Variable: vscode.SymbolKind.Variable,
  Constant: vscode.SymbolKind.Constant,
  Field: vscode.SymbolKind.Field,
  Property: vscode.SymbolKind.Property,
  Constructor: vscode.SymbolKind.Constructor,
  Trait: vscode.SymbolKind.Interface,
  TypeAlias: vscode.SymbolKind.TypeParameter,
};

export class KinWorkspaceSymbolProvider
  implements vscode.WorkspaceSymbolProvider
{
  constructor(private manager: WorkspaceManager) {}

  async provideWorkspaceSymbols(
    query: string,
    _token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    if (!query || query.length < 2) {
      return [];
    }

    // Search across all workspace roots and merge results.
    const allResults: vscode.SymbolInformation[] = [];
    for (const entry of this.manager.allEntries()) {
      try {
        const results = await entry.client.search(query);
        const workspacePath = entry.folder.uri.fsPath;
        for (const e of results) {
          allResults.push(toSymbolInformation(e, workspacePath));
        }
      } catch {
        // Skip failed workspace roots
      }
    }

    return allResults;
  }
}

function toSymbolInformation(
  entity: KinEntity,
  workspacePath: string,
): vscode.SymbolInformation {
  const uri = vscode.Uri.file(join(workspacePath, entity.file));
  const line = Math.max(0, entity.line - 1);
  const location = new vscode.Location(uri, new vscode.Position(line, 0));
  const kind = KIND_MAP[entity.kind] ?? vscode.SymbolKind.Variable;

  return new vscode.SymbolInformation(
    entity.name,
    kind,
    entity.file,
    location
  );
}
