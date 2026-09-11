// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinEntityFileSystemProvider } from "../entity-viewer";
import { renderEntityHover } from "../entity-hover";

/**
 * Hover over a `kin://` entity document.
 *
 * The document's bytes are the entity's body and nothing else, so the facts
 * about the entity have to live somewhere a reader can reach without leaving
 * the code: the tab carries its kind and name, and this carries its signature,
 * its provenance, its relations and whatever the graph disclosed about the
 * answer. Position is ignored on purpose; every part of the body belongs to the
 * same entity.
 */
export class KinEntityHoverProvider implements vscode.HoverProvider {
  constructor(private readonly provider: KinEntityFileSystemProvider) {}

  provideHover(document: vscode.TextDocument): vscode.Hover | undefined {
    const view = this.provider.viewFor(document.uri);
    if (!view) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(renderEntityHover(view));
    markdown.isTrusted = false;
    return new vscode.Hover(markdown);
  }
}
