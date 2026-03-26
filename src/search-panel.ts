// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import { join } from "path";
import {
  describeError,
  formatSearchResultDescription,
  formatSearchResultDetail,
  formatSearchResultLabel,
} from "./accessibility";

export async function showSearchQuickPick(
  client: KinClient,
  workspacePath: string
): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: "Search Kin entities by name",
    placeHolder: "Function name, class, module, or symbol",
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
    const uri = vscode.Uri.file(join(workspacePath, selected.entity.file));
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
    const uri = vscode.Uri.file(join(workspacePath, selected.entity.file));
    const line = selected.entity.line - 1;
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  }
}
