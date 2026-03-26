// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import { join } from "path";

type ExplorerNode = KindGroupNode | EntityNode;

interface KindGroupNode {
  type: "kind";
  kind: string;
  count: number;
}

interface EntityNode {
  type: "entity";
  entity: KinEntity;
}

export class EntityExplorerProvider
  implements vscode.TreeDataProvider<ExplorerNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ExplorerNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entities: KinEntity[] = [];
  private grouped: Map<string, KinEntity[]> = new Map();

  constructor(
    private client: KinClient,
    private workspacePath: string
  ) {}

  refresh(): void {
    this.entities = [];
    this.grouped.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    if (element.type === "kind") {
      const item = new vscode.TreeItem(
        `${element.kind} (${element.count})`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = "kindGroup";
      item.iconPath = new vscode.ThemeIcon("symbol-class");
      return item;
    }

    const e = element.entity;
    const item = new vscode.TreeItem(
      e.name,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = `${e.file}:${e.line}`;
    item.tooltip = e.signature || `${e.kind} ${e.name}`;
    item.contextValue = "entity";
    item.iconPath = iconForKind(e.kind);
    item.command = {
      command: "vscode.open",
      title: "Open Entity",
      arguments: [
        vscode.Uri.file(join(this.workspacePath, e.file)),
        { selection: new vscode.Range(e.line - 1, 0, e.line - 1, 0) },
      ],
    };
    return item;
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      return this.getKindGroups();
    }
    if (element.type === "kind") {
      const entities = this.grouped.get(element.kind) || [];
      return entities.map((entity) => ({ type: "entity" as const, entity }));
    }
    return [];
  }

  private async getKindGroups(): Promise<ExplorerNode[]> {
    try {
      this.entities = await this.client.entities();
    } catch {
      this.entities = [];
    }

    this.grouped.clear();
    for (const entity of this.entities) {
      const kind = entity.kind || "Unknown";
      if (!this.grouped.has(kind)) {
        this.grouped.set(kind, []);
      }
      this.grouped.get(kind)!.push(entity);
    }

    const groups: ExplorerNode[] = [];
    for (const [kind, entities] of this.grouped) {
      groups.push({ type: "kind", kind, count: entities.length });
    }
    return groups.sort((a, b) => {
      if (a.type === "kind" && b.type === "kind") {
        return a.kind.localeCompare(b.kind);
      }
      return 0;
    });
  }
}

function iconForKind(kind: string): vscode.ThemeIcon {
  const map: Record<string, string> = {
    Function: "symbol-function",
    Class: "symbol-class",
    Module: "symbol-module",
    Method: "symbol-method",
    Interface: "symbol-interface",
    Struct: "symbol-struct",
    Enum: "symbol-enum",
    Variable: "symbol-variable",
    Constant: "symbol-constant",
    Type: "symbol-type-parameter",
  };
  return new vscode.ThemeIcon(map[kind] || "symbol-misc");
}
