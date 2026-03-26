// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient } from "./kin-client";
import { formatStatusBarText, formatStatusBarTooltip } from "./accessibility";

export class KinStatusBar {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private client: KinClient) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.item.name = "Kin status";
    this.item.command = {
      command: "kin.overview",
      title: "Open Kin graph overview",
    };
    this.item.tooltip = "Kin status. Loading workspace state...";
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
      this.item.text = formatStatusBarText(status);
      this.item.tooltip = formatStatusBarTooltip(status);
    } catch {
      this.item.text = "$(graph) Kin: unavailable";
      this.item.tooltip =
        "Kin status. This workspace is temporarily unavailable. Click to open the overview.";
    }
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
