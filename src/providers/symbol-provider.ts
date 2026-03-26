// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "../kin-client";
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
  constructor(
    private client: KinClient,
    private workspacePath: string
  ) {}

  async provideWorkspaceSymbols(
    query: string,
    _token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    if (!query || query.length < 2) {
      return [];
    }

    let results: KinEntity[];
    try {
      results = await this.client.search(query);
    } catch {
      return [];
    }

    return results.map((e) => this.toSymbolInformation(e));
  }

  private toSymbolInformation(entity: KinEntity): vscode.SymbolInformation {
    const uri = vscode.Uri.file(join(this.workspacePath, entity.file));
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
}
