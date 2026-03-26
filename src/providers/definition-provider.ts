// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "../kin-client";
import { logError } from "../logger";
import { join } from "path";

export class KinDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private client: KinClient,
    private workspacePath: string
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range);
    if (!word || word.length < 2) {
      return undefined;
    }

    let results: KinEntity[];
    try {
      results = await this.client.traceQuick(word);
    } catch {
      return undefined;
    }

    if (results.length === 0) {
      return undefined;
    }

    // Prefer exact name match or suffix match (e.g. module.funcName)
    const exact = results.filter(
      (e) => e.name === word || e.name.endsWith(`.${word}`)
    );
    const candidates = exact.length > 0 ? exact : results;

    // Single result — jump directly
    if (candidates.length === 1) {
      return this.toLocation(candidates[0]);
    }

    // Multiple results — return all and let VS Code show peek
    return candidates.map((e) => this.toLocation(e));
  }

  private toLocation(entity: KinEntity): vscode.Location {
    const uri = vscode.Uri.file(join(this.workspacePath, entity.file));
    const line = Math.max(0, entity.line - 1);
    return new vscode.Location(uri, new vscode.Position(line, 0));
  }
}
