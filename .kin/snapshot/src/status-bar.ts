// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient } from "./kin-client";

export class KinStatusBar {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private client: KinClient) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.item.command = "kin.overview";
    this.item.tooltip = "Click for Kin graph overview";
    this.item.show();

    // Update on file save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => this.update())
    );

    this.update();
  }

  async update(): Promise<void> {
    try {
      const status = await this.client.status();
      if (status.initialized) {
        this.item.text = `$(graph) Kin: ${status.entityCount} entities`;
      } else {
        this.item.text = "$(graph) Kin: not initialized";
      }
    } catch {
      this.item.text = "$(graph) Kin: unavailable";
    }
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
