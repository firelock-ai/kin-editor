// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { join } from "path";
import { KinClient, KinRenameEdit, KinRenamePlan } from "../kin-client";
import { WorkspaceManager } from "../workspace-manager";
import { describeError } from "../accessibility";

export class KinRenameProvider implements vscode.RenameProvider {
  constructor(private manager: WorkspaceManager) {}

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    _token: vscode.CancellationToken
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const resolved = this.resolveClient(document);
    if (!resolved) {
      return undefined;
    }

    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    const symbol = document.getText(range);
    if (!symbol || symbol.trim().length === 0) {
      return undefined;
    }

    let plan: KinRenamePlan;
    try {
      plan = await resolved.client.renamePlan(
        symbol,
        newName,
        document.uri.fsPath,
        position.line + 1,
        position.character + 1
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Kin rename failed: ${describeError(err)}`);
      return undefined;
    }

    if (!plan.edits || plan.edits.length === 0) {
      vscode.window.showErrorMessage(
        `Kin rename returned no edits for ${symbol}.`
      );
      return undefined;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of plan.edits) {
      let resolvedEdit:
        | { uri: vscode.Uri; range: vscode.Range; text: string }
        | undefined;
      try {
        resolvedEdit = await this.resolveEdit(
          resolved.workspacePath,
          plan,
          edit
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Kin rename failed while resolving edits: ${describeError(err)}`
        );
        return undefined;
      }
      if (!resolvedEdit) {
        vscode.window.showErrorMessage(
          `Kin rename could not resolve an edit for ${edit.file}.`
        );
        return undefined;
      }

      workspaceEdit.replace(resolvedEdit.uri, resolvedEdit.range, resolvedEdit.text);
    }

    if (plan.warnings && plan.warnings.length > 0) {
      const summary = plan.warnings.slice(0, 3).join("; ");
      const suffix = plan.warnings.length > 3 ? " ..." : "";
      void vscode.window.showWarningMessage(
        `Kin rename completed with warnings: ${summary}${suffix}`
      );
    }

    return workspaceEdit;
  }

  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Range | { range: vscode.Range; placeholder: string } | undefined> {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    const placeholder = document.getText(range);
    if (!placeholder) {
      return undefined;
    }

    return { range, placeholder };
  }

  private resolveClient(
    document: vscode.TextDocument
  ): { client: KinClient; workspacePath: string } | undefined {
    const client = this.manager.getClientForPath(document.uri.fsPath);
    if (!client) {
      return undefined;
    }

    return {
      client,
      workspacePath: client.getWorkspacePath(),
    };
  }

  private async resolveEdit(
    workspacePath: string,
    plan: KinRenamePlan,
    edit: KinRenameEdit
  ): Promise<{ uri: vscode.Uri; range: vscode.Range; text: string } | undefined> {
    const uri = vscode.Uri.file(join(workspacePath, edit.file));
    const text = edit.newText ?? edit.replacement ?? edit.text ?? plan.newName;
    const range = await this.resolveRange(uri, plan, edit);
    if (!range) {
      return undefined;
    }

    return { uri, range, text };
  }

  private async resolveRange(
    uri: vscode.Uri,
    plan: KinRenamePlan,
    edit: KinRenameEdit
  ): Promise<vscode.Range | undefined> {
    const explicit = this.rangeFromExplicitCoordinates(edit);
    if (explicit) {
      return explicit;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const lineNumber =
      this.pickLine(edit.startLine, edit.line, edit.endLine) ??
      this.extractEntityLine(plan.entity);
    if (lineNumber === undefined) {
      return undefined;
    }

    const lineIndex = lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= document.lineCount) {
      return undefined;
    }

    const line = document.lineAt(lineIndex);
    const target = this.extractEntityName(plan.entity);
    if (target) {
      const wordRange = this.findTokenRange(line.text, target);
      if (wordRange) {
        return new vscode.Range(
          new vscode.Position(lineIndex, wordRange.start),
          new vscode.Position(lineIndex, wordRange.end)
        );
      }
    }

    return line.range;
  }

  private rangeFromExplicitCoordinates(
    edit: KinRenameEdit
  ): vscode.Range | undefined {
    const startLine = this.pickLine(edit.startLine);
    const endLine = this.pickLine(edit.endLine);
    if (startLine === undefined) {
      return undefined;
    }

    const startCharacter = this.pickColumn(
      edit.startCharacter,
      edit.startCol,
      edit.column,
      edit.character
    );
    const endCharacter = this.pickColumn(
      edit.endCharacter,
      edit.endCol,
      edit.column,
      edit.character,
      startCharacter
    );
    if (
      startCharacter === undefined &&
      endCharacter === undefined &&
      endLine === undefined
    ) {
      return undefined;
    }

    const start = new vscode.Position(startLine - 1, startCharacter ?? 0);
    const end = new vscode.Position(
      Math.max(startLine, endLine ?? startLine) - 1,
      endCharacter ?? startCharacter ?? 0
    );
    return new vscode.Range(start, end);
  }

  private pickLine(...values: Array<number | undefined>): number | undefined {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return undefined;
  }

  private pickColumn(...values: Array<number | undefined>): number | undefined {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
    return undefined;
  }

  private extractEntityName(
    entity: KinRenamePlan["entity"]
  ): string | undefined {
    if (typeof entity === "string") {
      return entity;
    }
    return entity?.name;
  }

  private extractEntityLine(
    entity: KinRenamePlan["entity"]
  ): number | undefined {
    if (typeof entity === "string") {
      return undefined;
    }
    return this.pickLine(entity?.line);
  }

  private findTokenRange(
    lineText: string,
    token: string
  ): { start: number; end: number } | undefined {
    if (!token) {
      return undefined;
    }

    let index = lineText.indexOf(token);
    while (index >= 0) {
      const before = index > 0 ? lineText[index - 1] : "";
      const afterIndex = index + token.length;
      const after = afterIndex < lineText.length ? lineText[afterIndex] : "";
      if (!this.isIdentifierChar(before) && !this.isIdentifierChar(after)) {
        return { start: index, end: afterIndex };
      }
      index = lineText.indexOf(token, index + token.length);
    }
    return undefined;
  }

  private isIdentifierChar(char: string): boolean {
    return /[A-Za-z0-9_$]/.test(char);
  }
}
