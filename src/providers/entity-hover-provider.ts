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
    const draft = this.provider.draftFor(document.uri);
    if (draft) {
      const markdown = new vscode.MarkdownString();
      markdown.appendText(`Kin draft ${draft.draft_id} · saved revision ${draft.revision}\n\n${document.isDirty ? "This buffer has unsaved changes." : "This text is a saved draft."} Save does not publish source. Use Apply Saved Draft to publish a saved revision.\n\n${draft.pending_apply ? "An interrupted Apply retains its original revision and session. Resume it to recover the original result." : "Compare with Current Source to inspect repository authority."}\n\nGraph findings and relations describe published source; they are not diagnostics for this draft.`);
      return new vscode.Hover(markdown);
    }
    const view = this.provider.viewFor(document.uri);
    if (!view) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(renderEntityHover(view));
    markdown.isTrusted = false;
    return new vscode.Hover(markdown);
  }
}
