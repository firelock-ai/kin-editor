// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import { isAbsolute, join } from "path";
import {
  describeError,
  formatSearchResultDescription,
  formatSearchResultDetail,
  formatSearchResultLabel,
} from "./accessibility";

/**
 * Resolve an entity file path to an absolute URI.
 * Guards against `path.join` silently discarding `workspacePath` when
 * the engine returns an absolute path for entity.file.
 */
function resolveEntityUri(workspacePath: string, entityFile: string): vscode.Uri {
  return vscode.Uri.file(
    isAbsolute(entityFile) ? entityFile : join(workspacePath, entityFile)
  );
}

export async function showSearchQuickPick(
  client: KinClient,
  workspacePath: string
): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: "Semantic search (powered by the Kin graph — not substring matching)",
    placeHolder: "Describe what you're looking for: e.g. 'retry logic', 'auth handler'",
  });

  if (!query) {
    return;
  }

  let results: KinEntity[];
  try {
    results = await client.search(query);
  } catch (err) {
    vscode.window.showErrorMessage(`Kin Search failed: ${describeError(err)}`);
    return;
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(
      `Kin Search: no entities found for "${query}".`
    );
    return;
  }

  const items = results.map((e) => ({
    label: formatSearchResultLabel(e),
    description: formatSearchResultDescription(e),
    detail: formatSearchResultDetail(e),
    entity: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${results.length} result${results.length === 1 ? "" : "s"} for "${query}"`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (selected) {
    const uri = resolveEntityUri(workspacePath, selected.entity.file);
    const line = selected.entity.line - 1;
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  }
}

export async function showTraceQuickPick(
  client: KinClient,
  workspacePath: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const word = editor
    ? editor.document.getText(
        editor.document.getWordRangeAtPosition(editor.selection.active)
      )
    : undefined;

  const entity = await vscode.window.showInputBox({
    prompt: "Trace an entity through the Kin graph",
    placeHolder: "Entity name or symbol",
    value: word || "",
  });

  if (!entity) {
    return;
  }

  let results: KinEntity[];
  try {
    results = await client.trace(entity);
  } catch (err) {
    vscode.window.showErrorMessage(`Kin Trace failed: ${describeError(err)}`);
    return;
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(
      `Kin Trace: no related entities found for "${entity}".`
    );
    return;
  }

  const items = results.map((e) => ({
    label: formatSearchResultLabel(e),
    description: formatSearchResultDescription(e),
    detail: formatSearchResultDetail(e),
    entity: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Trace results for "${entity}"`,
  });

  if (selected) {
    const uri = resolveEntityUri(workspacePath, selected.entity.file);
    const line = selected.entity.line - 1;
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  }
}
