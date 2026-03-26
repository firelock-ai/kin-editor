// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient } from "../kin-client";

/** A single finding from `kin review`. */
export interface ReviewFinding {
  entity: string;
  kind: string;
  file: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

/** Top-level result from `kin review --json`. */
export interface ReviewResult {
  file: string;
  findings: ReviewFinding[];
  summary: string;
}

export class KinReviewProvider implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private warningDecorationType: vscode.TextEditorDecorationType;
  private errorDecorationType: vscode.TextEditorDecorationType;
  private infoDecorationType: vscode.TextEditorDecorationType;
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor(private client: KinClient) {
    this.outputChannel = vscode.window.createOutputChannel("Kin Review");

    this.warningDecorationType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor(
        "editorWarning.foreground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      before: {
        contentText: "!",
        color: new vscode.ThemeColor("editorWarning.foreground"),
        margin: "0 4px 0 0",
        fontWeight: "bold",
      },
    });

    this.errorDecorationType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      before: {
        contentText: "!",
        color: new vscode.ThemeColor("editorError.foreground"),
        margin: "0 4px 0 0",
        fontWeight: "bold",
      },
    });

    this.infoDecorationType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor(
        "editorInfo.foreground"
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      before: {
        contentText: "i",
        color: new vscode.ThemeColor("editorInfo.foreground"),
        margin: "0 4px 0 0",
      },
    });

    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("kin-review");
  }

  /**
   * Run `kin review` on the given file and display results.
   * If no file is provided, uses the active editor's file.
   */
  async reviewFile(filePath?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const targetPath = filePath ?? editor?.document.uri.fsPath;

    if (!targetPath) {
      vscode.window.showWarningMessage(
        "Kin Review: No file is open to review."
      );
      return;
    }

    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`Reviewing: ${targetPath}`);
    this.outputChannel.appendLine("---");

    let result: ReviewResult;
    try {
      result = await this.client.review(targetPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Review failed: ${msg}`);
      vscode.window.showErrorMessage(`Kin Review failed: ${msg}`);
      return;
    }

    // Display findings in the output channel
    if (result.findings.length === 0) {
      this.outputChannel.appendLine("No findings detected.");
      vscode.window.showInformationMessage("Kin Review: no findings.");
      this.clearDecorations();
      return;
    }

    this.outputChannel.appendLine(
      `Found ${result.findings.length} finding(s):\n`
    );

    for (const finding of result.findings) {
      const icon =
        finding.severity === "error"
          ? "[ERROR]"
          : finding.severity === "warning"
            ? "[WARN]"
            : "[INFO]";
      this.outputChannel.appendLine(
        `${icon} ${finding.entity} (${finding.kind}) at line ${finding.line}`
      );
      this.outputChannel.appendLine(`  ${finding.message}`);
      this.outputChannel.appendLine("");
    }

    if (result.summary) {
      this.outputChannel.appendLine("---");
      this.outputChannel.appendLine(`Summary: ${result.summary}`);
    }

    // Apply gutter decorations to the active editor if it matches
    if (editor && editor.document.uri.fsPath === targetPath) {
      this.applyDecorations(editor, result.findings);
    }

    // Publish diagnostics
    this.publishDiagnostics(targetPath, result.findings);

    const errorCount = result.findings.filter(
      (f) => f.severity === "error"
    ).length;
    const warnCount = result.findings.filter(
      (f) => f.severity === "warning"
    ).length;

    vscode.window.showInformationMessage(
      `Kin Review: ${errorCount} error(s), ${warnCount} warning(s), ${result.findings.length - errorCount - warnCount} info finding(s).`
    );
  }

  private applyDecorations(
    editor: vscode.TextEditor,
    findings: ReviewFinding[]
  ): void {
    this.clearDecorations(editor);

    const warnings: vscode.DecorationOptions[] = [];
    const errors: vscode.DecorationOptions[] = [];
    const infos: vscode.DecorationOptions[] = [];

    for (const finding of findings) {
      const line = Math.max(0, finding.line - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const decoration: vscode.DecorationOptions = {
        range,
        hoverMessage: new vscode.MarkdownString(
          `**Kin Review** [${finding.severity}]\n\n` +
            `\`${finding.kind}\` **${finding.entity}**\n\n` +
            finding.message
        ),
      };

      switch (finding.severity) {
        case "error":
          errors.push(decoration);
          break;
        case "warning":
          warnings.push(decoration);
          break;
        default:
          infos.push(decoration);
          break;
      }
    }

    editor.setDecorations(this.warningDecorationType, warnings);
    editor.setDecorations(this.errorDecorationType, errors);
    editor.setDecorations(this.infoDecorationType, infos);
  }

  private publishDiagnostics(
    filePath: string,
    findings: ReviewFinding[]
  ): void {
    const uri = vscode.Uri.file(filePath);
    const diagnostics: vscode.Diagnostic[] = findings.map((finding) => {
      const line = Math.max(0, finding.line - 1);
      const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
      const severity =
        finding.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : finding.severity === "warning"
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;

      const diag = new vscode.Diagnostic(range, finding.message, severity);
      diag.source = "kin-review";
      diag.code = finding.kind;
      return diag;
    });

    this.diagnosticCollection.set(uri, diagnostics);
  }

  private clearDecorations(editor?: vscode.TextEditor): void {
    const target = editor ?? vscode.window.activeTextEditor;
    if (target) {
      target.setDecorations(this.warningDecorationType, []);
      target.setDecorations(this.errorDecorationType, []);
      target.setDecorations(this.infoDecorationType, []);
    }
    this.diagnosticCollection.clear();
  }

  dispose(): void {
    this.outputChannel.dispose();
    this.warningDecorationType.dispose();
    this.errorDecorationType.dispose();
    this.infoDecorationType.dispose();
    this.diagnosticCollection.dispose();
  }
}
