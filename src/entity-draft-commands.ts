// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinEntityFileSystemProvider, draftUri, entityUri, ViewerWorkspace } from "./entity-viewer";
import { parseEntityUriParts } from "./graph-uri";

/** Editor presentation only; the daemon owns the draft and publication state. */
export class EntityDraftCommands implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
  private readonly subscriptions: vscode.Disposable[];
  private contextState = "";

  constructor(private readonly provider: KinEntityFileSystemProvider) {
    this.status.name = "Kin entity draft";
    this.status.command = "kin.applyDraft";
    this.subscriptions = [
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.refresh()),
    ];
    this.refresh();
  }

  private document(): vscode.TextDocument {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme !== "kin") throw new Error("Open an entity from the Kin Graph Browser first.");
    return document;
  }

  async edit(): Promise<void> {
    await this.run(async () => {
      const target = await this.provider.startDraft(this.document().uri);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
      void vscode.window.showInformationMessage("Save keeps this draft, including unfinished code. Apply Saved Draft publishes a saved revision to Kin.");
    });
  }

  async apply(resume = false): Promise<void> {
    await this.run(async () => {
      const document = this.document();
      if (document.isDirty) throw new Error("Save this draft before Apply. Apply publishes an acknowledged saved revision.");
      const result = await this.provider.applyDraft(document.uri, resume);
      const detail = result.current_text_applied
        ? "The receipt covers the saved text."
        : "Newer saved text is still unapplied.";
      void vscode.window.showInformationMessage(
        `Apply receipt saved for draft revision ${result.applied_draft_revision}. ${detail} Compare with current source to see what the repository contains now.`,
      );
      this.provider.invalidateAll();
    });
  }

  async compare(): Promise<void> {
    await this.run(async () => {
      const draft = this.document();
      if (!parseEntityUriParts(draft.uri)?.draftId) throw new Error("Open a saved draft to compare it with current source.");
      const current = this.provider.currentSourceUri(draft.uri);
      await vscode.workspace.openTextDocument(current);
      await vscode.commands.executeCommand("vscode.diff", current, draft.uri, "Kin: Current Source ↔ Draft", { preview: false });
    });
  }

  async fresh(): Promise<void> {
    await this.run(async () => {
      const old = this.document();
      const current = this.provider.currentSourceUri(old.uri);
      await vscode.workspace.openTextDocument(current);
      const target = await this.provider.startDraft(current);
      await vscode.workspace.openTextDocument(target);
      await vscode.commands.executeCommand("vscode.diff", old.uri, target, "Kin: Retained Draft ↔ New Draft from Current Source", { preview: false });
      void vscode.window.showInformationMessage("The new draft starts from current source. Copy the changes you choose into it, then Save and Apply. The old draft and any interrupted Apply remain retained.");
    });
  }

  async openDrafts(): Promise<void> {
    await this.run(async () => {
      const workspace = await this.chooseWorkspace();
      if (!workspace) return;
      let after: string | undefined;
      for (;;) {
        const page = await workspace.client.listDrafts({ after, limit: 50 });
        if (page.recovery_evidence.length > 0) {
          void vscode.window.showWarningMessage(`Kin retained recovery evidence that needs inspection before further writes: ${page.recovery_evidence.slice(0, 3).join(", ").slice(0, 500)}${page.recovery_evidence.length > 3 ? " …" : ""}. Existing drafts remain available below.`);
        }
        const items: Array<vscode.QuickPickItem & { draftId?: string; entityId?: string; more?: boolean }> = page.drafts.map(draft => ({
          label: `Draft ${draft.draft_id}`,
          description: `Revision ${draft.revision}${draft.has_pending_apply ? " · interrupted Apply" : ""}`,
          detail: `Entity ${draft.scope.entity_id} · ${draft.body_bytes} bytes`,
          draftId: draft.draft_id, entityId: draft.scope.entity_id,
        }));
        if (page.next_cursor) items.push({ label: "More saved drafts…", more: true });
        if (items.length === 0) { void vscode.window.showInformationMessage("No saved entity drafts in this workspace."); return; }
        const selected = await vscode.window.showQuickPick(items, { title: "Kin saved drafts", placeHolder: "Drafts remain available after their entities are deleted" });
        if (!selected) return;
        if (selected.more) { after = page.next_cursor ?? undefined; continue; }
        const source = entityUri({ workspaceKey: workspace.key, entityId: selected.entityId!, kind: "Draft", name: selected.draftId! });
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(draftUri(source, selected.draftId!)), { preview: false });
        return;
      }
    });
  }

  async recoverRevision(): Promise<void> {
    await this.run(async () => {
      const workspace = await this.chooseWorkspace();
      if (!workspace) return;
      const current = vscode.window.activeTextEditor?.document.uri;
      const draftId = await vscode.window.showInputBox({ title: "Recover a saved draft revision", prompt: "Draft UUID (read independently of the latest revision)", value: current?.scheme === "kin" ? parseEntityUriParts(current)?.draftId : undefined });
      if (!draftId) return;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftId)) throw new Error("Enter a valid draft UUID.");
      const value = await vscode.window.showInputBox({ title: "Recover a saved draft revision", prompt: "Earlier acknowledged revision number" });
      if (value === undefined) return;
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Enter a positive revision number.");
      const revision = Number(value);
      const draft = await workspace.client.readDraft(draftId, revision);
      const source = entityUri({ workspaceKey: workspace.key, entityId: draft.scope.entity_id, kind: "Recovered Draft", name: draftId });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(draftUri(source, draftId, revision)), { preview: false });
    });
  }

  private async chooseWorkspace(): Promise<ViewerWorkspace | undefined> {
    const all = this.provider.availableWorkspaces();
    const uri = vscode.window.activeTextEditor?.document.uri;
    const active = uri?.scheme === "kin" ? all.find(workspace => workspace.key === uri.authority) : undefined;
    if (active) return active;
    if (all.length === 1) return all[0];
    return (await vscode.window.showQuickPick(all.map(workspace => ({ label: workspace.workspacePath, workspace })), { title: "Choose the Kin workspace holding the draft" }))?.workspace;
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) {
      void vscode.window.showErrorMessage(`${error instanceof Error ? error.message : String(error)}\nSaved drafts remain available through Kin: Open Saved Draft. Use Compare with Current Source or New Draft from Current Source for a stale or refused Apply.`);
    } finally { this.refresh(); }
  }

  refresh(): void {
    const document = vscode.window.activeTextEditor?.document;
    const address = document?.uri.scheme === "kin" ? parseEntityUriParts(document.uri) : undefined;
    const isDraft = !!address?.draftId;
    const recovery = address?.draftRevision;
    const state = `${!!address}:${isDraft}:${recovery !== undefined}`;
    if (state !== this.contextState) {
      this.contextState = state;
      void vscode.commands.executeCommand("setContext", "kin.entitySource", !!address && !isDraft);
      void vscode.commands.executeCommand("setContext", "kin.entityDraft", isDraft);
      void vscode.commands.executeCommand("setContext", "kin.entityDraftRecovery", recovery !== undefined);
    }
    const draft = document?.uri.scheme === "kin" ? this.provider.draftFor(document.uri) : undefined;
    if (!document || !draft) { this.status.hide(); return; }
    const pending = draft.pending_apply;
    const applied = draft.applied_receipt?.attempt.draft_revision === draft.content_revision;
    this.status.text = recovery !== undefined ? `$(history) Kin draft · recovery r${recovery}` : document.isDirty ? "$(edit) Kin draft · unsaved"
      : pending ? "$(history) Kin draft · Apply pending"
      : applied ? "$(check) Kin draft · receipt saved"
      : "$(save) Kin draft · saved, unapplied";
    this.status.tooltip = `Draft ${draft.draft_id}, saved revision ${draft.revision}. Save preserves editing text. Apply publishes a saved revision; a receipt is historical evidence, not a current source read.`;
    this.status.show();
  }

  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); }
}
