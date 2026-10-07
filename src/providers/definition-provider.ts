// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinReference, ReferenceTarget } from "../kin-client";
import { referenceTargets } from "../graph-references";
import { WorkspaceManager } from "../workspace-manager";
import { isAbsolute, join } from "path";

/** How long one caller's entity record may take on this per-word path. */
const RECORD_TIMEOUT_MS = 3_000;

/**
 * Callers whose positions are read from their entity records on one jump.
 * Past this, a caller opens at its projected file with no line, so a symbol
 * with hundreds of callers cannot fan one Ctrl+hover out into hundreds of
 * graph reads.
 */
const MAX_RESOLVED_CALLERS = 20;

export class KinDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private manager: WorkspaceManager) {}

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

    const client = this.manager.getClientForPath(document.uri.fsPath);
    if (!client) {
      return undefined;
    }
    const workspacePath = client.getWorkspacePath();

    let results: KinReference[];
    try {
      results = await client.traceQuick(word);
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

    // A `find_references` row carries no file line. Each caller's positions
    // come from its own entity record: one location per site inside it, or the
    // caller itself when no site has a line.
    const resolved = await Promise.all(
      candidates.map((reference, index) =>
        index < MAX_RESOLVED_CALLERS
          ? client.referenceTargets(reference, RECORD_TIMEOUT_MS)
          : Promise.resolve(referenceTargets(reference, undefined))
      )
    );
    const locations = resolved
      .flat()
      .map((target) => toLocation(target, workspacePath));

    if (locations.length === 0) {
      return undefined;
    }
    // One location jumps directly; several let VS Code show peek.
    return locations.length === 1 ? locations[0] : locations;
  }
}

function toLocation(target: ReferenceTarget, workspacePath: string): vscode.Location {
  const uri = vscode.Uri.file(
    isAbsolute(target.file) ? target.file : join(workspacePath, target.file)
  );
  // A target with no derivable line opens the projected file at its top rather
  // than at an invented line.
  const line = target.line !== undefined ? Math.max(0, target.line - 1) : 0;
  return new vscode.Location(uri, new vscode.Position(line, 0));
}
