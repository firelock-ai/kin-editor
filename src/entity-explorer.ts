// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import { join } from "path";
import { logError } from "./logger";
import {
  formatEntityAccessibilityLabel,
  formatEntityDescription,
  formatEntityTooltip,
  formatKindGroupAccessibilityLabel,
  formatKindGroupLabel,
  formatKindGroupTooltip,
} from "./accessibility";

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

  /** Kind counts from the initial overview load (cheap). */
  private kindCounts: Map<string, number> = new Map();
  /** Cached full entity list used to slice kind groups deterministically. */
  private allEntities: KinEntity[] | undefined;
  /** Per-kind entity cache — populated lazily on expand. */
  private kindEntities: Map<string, KinEntity[]> = new Map();

  constructor(
    private client: KinClient,
    private workspacePath: string
  ) {}

  refresh(): void {
    this.kindCounts.clear();
    this.allEntities = undefined;
    this.kindEntities.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    if (element.type === "kind") {
      const item = new vscode.TreeItem(
        formatKindGroupLabel(element.kind, element.count),
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = "kindGroup";
      item.iconPath = new vscode.ThemeIcon("symbol-class");
      item.tooltip = formatKindGroupTooltip(element.kind, element.count);
      item.accessibilityInformation = {
        label: formatKindGroupAccessibilityLabel(element.kind, element.count),
        role: "treeitem",
      };
      return item;
    }

    const e = element.entity;
    const item = new vscode.TreeItem(
      e.name,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = formatEntityDescription(e);
    item.tooltip = formatEntityTooltip(e);
    item.contextValue = "entity";
    item.iconPath = iconForKind(e.kind);
    item.resourceUri = vscode.Uri.file(join(this.workspacePath, e.file));
    item.accessibilityInformation = {
      label: formatEntityAccessibilityLabel(e),
      role: "treeitem",
    };
    item.command = {
      command: "vscode.open",
      title: "Open Kin Entity",
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
      return this.getEntitiesForKind(element.kind);
    }
    return [];
  }

  /**
   * Load only the kind counts via overview (lightweight).
   * Entities are fetched per-kind on tree node expand.
   */
  private async getKindGroups(): Promise<ExplorerNode[]> {
    if (this.kindCounts.size === 0) {
      try {
        const overview = await this.client.overview();
        for (const [kind, count] of Object.entries(overview.kinds)) {
          this.kindCounts.set(kind, count);
        }
      } catch (err) {
        logError("Failed to load entity overview", err);
      }
    }

    const groups: ExplorerNode[] = [];
    for (const [kind, count] of this.kindCounts) {
      groups.push({ type: "kind", kind, count });
    }
    return groups.sort((a, b) => {
      if (a.type === "kind" && b.type === "kind") {
        return a.kind.localeCompare(b.kind);
      }
      return 0;
    });
  }

  /**
   * Lazily load entities for a specific kind on tree expand.
   * Results are cached until the next refresh().
   */
  private async getEntitiesForKind(kind: string): Promise<ExplorerNode[]> {
    let entities = this.kindEntities.get(kind);
    if (!entities) {
      try {
        if (!this.allEntities) {
          this.allEntities = await this.client.entities();
        }
        entities = this.allEntities.filter((e) => (e.kind || "Unknown") === kind);
        this.kindEntities.set(kind, entities);
      } catch (err) {
        logError(`Failed to load entities for kind: ${kind}`, err);
        entities = [];
      }
    }
    return entities.map((entity) => ({ type: "entity" as const, entity }));
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
