// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { GraphFinding } from "./graph-findings";

/**
 * The daemon's semantic findings, published on the entity document they qualify.
 *
 * Kin already says what it could not do for an answer, in the `_kin` envelope
 * on every tool result and in `kin_graph_status`. Until now the extension threw
 * all of it away and rendered the payload, which is how a partial answer, a
 * suspended enrichment sweep and a set of call sites that resolved to nothing
 * reached a reader as a clean-looking body with nothing beside it.
 *
 * Findings land on line 1 of the entity document, which is the entity's own
 * declaration: they are statements about this entity's place in the graph
 * rather than about a particular statement inside it, and the declaration is
 * the one line every reader looks at.
 */
export class GraphDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(collection?: vscode.DiagnosticCollection) {
    this.collection =
      collection ?? vscode.languages.createDiagnosticCollection("kin-graph");
  }

  publish(uri: vscode.Uri, findings: readonly GraphFinding[]): void {
    if (findings.length === 0) {
      this.collection.delete(uri);
      return;
    }
    this.collection.set(
      uri,
      findings.map((finding) => toDiagnostic(finding))
    );
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

export function toDiagnostic(finding: GraphFinding): vscode.Diagnostic {
  const range = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
  const diagnostic = new vscode.Diagnostic(
    range,
    finding.message,
    severityOf(finding.severity)
  );
  // `kin` rather than `kin-review`: these come from the graph's own disclosures
  // about this answer, not from a review pass, and a reader filtering the
  // problems pane should be able to tell the two apart.
  diagnostic.source = "kin";
  diagnostic.code = finding.code;
  return diagnostic;
}

export function severityOf(
  severity: GraphFinding["severity"]
): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}
