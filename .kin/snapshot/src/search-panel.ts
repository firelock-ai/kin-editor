// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import { join } from "path";

export async function showSearchQuickPick(
  client: KinClient,
  workspacePath: string
): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: "Search Kin entities",
    placeHolder: "Function name, class, module...",
  });

  if (!query) {
    return;
  }

  let results: KinEntity[];
  try {
    results = await client.search(query);
  } catch (err) {
    vscode.window.showErrorMessage(`Kin search failed: ${err}`);
    return;
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(`No entities found for "${query}"`);
    return;
  }

  const items = results.map((e) => ({
    label: `$(symbol-${kindIcon(e.kind)}) ${e.name}`,
    description: `${e.file}:${e.line}`,
    detail: e.signature || e.kind,
    entity: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${results.length} result(s) for "${query}"`,
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
    prompt: "Trace entity through the graph",
    placeHolder: "Entity name",
    value: word || "",
  });

  if (!entity) {
    return;
  }

  let results: KinEntity[];
  try {
    results = await client.trace(entity);
  } catch (err) {
    vscode.window.showErrorMessage(`Kin trace failed: ${err}`);
    return;
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(`No trace results for "${entity}"`);
    return;
  }

  const items = results.map((e) => ({
    label: `$(symbol-${kindIcon(e.kind)}) ${e.name}`,
    description: `${e.file}:${e.line}`,
    detail: e.signature || e.kind,
    entity: e,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Trace: ${results.length} related entity(ies)`,
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

function kindIcon(kind: string): string {
  const map: Record<string, string> = {
    Function: "function",
    Class: "class",
    Module: "module",
    Method: "method",
    Interface: "interface",
    Struct: "struct",
    Enum: "enum",
    Variable: "variable",
    Constant: "constant",
  };
  return map[kind] || "misc";
}
