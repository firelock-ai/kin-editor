// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import { isAbsolute, join } from "path";
import { logError } from "./logger";
import {
  formatEntityAccessibilityLabel,
  formatEntityDescription,
  formatEntityTooltip,
  formatKindGroupAccessibilityLabel,
  formatKindGroupLabel,
  formatKindGroupTooltip,
} from "./accessibility";

/**
 * Resolve an entity file path to an absolute URI.
 * Guards against `path.join` silently discarding `workspacePath` when
 * the engine returns an absolute path for entity.file.
 */
function resolveEntityUri(workspacePath: string, entityFile: string): vscode.Uri {
  return vscode.Uri.file(
    isAbsolute(entityFile) ? entityFile : join(workspacePath, entityFile)
  );
}

type ExplorerNode = KindGroupNode | EntityNode | InfoNode;

interface KindGroupNode {
  type: "kind";
  kind: string;
  count: number;
}

interface EntityNode {
  type: "entity";
  entity: KinEntity;
}

interface InfoNode {
  type: "info";
  message: string;
  tooltip: string;
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
    if (element.type === "info") {
      const item = new vscode.TreeItem(
        element.message,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "kinInfo";
      item.iconPath = new vscode.ThemeIcon("info");
      item.tooltip = element.tooltip;
      item.accessibilityInformation = {
        label: element.message,
        role: "treeitem",
      };
      return item;
    }

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
    item.resourceUri = resolveEntityUri(this.workspacePath, e.file);
    item.accessibilityInformation = {
      label: formatEntityAccessibilityLabel(e),
      role: "treeitem",
    };
    item.command = {
      command: "vscode.open",
      title: "Open Kin Entity",
      arguments: [
        resolveEntityUri(this.workspacePath, e.file),
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
   *
   * When the graph cannot be read or holds no entities yet, an honest info
   * node is returned instead of a silently empty tree, so a demoer never sees
   * a hollow graph presented as real data.
   */
  private async getKindGroups(): Promise<ExplorerNode[]> {
    if (this.kindCounts.size === 0) {
      try {
        const overview = await this.client.overview();
        if (!overview.indexed) {
          return [graphNotIndexedNode()];
        }
        for (const [kind, count] of Object.entries(overview.kinds)) {
          this.kindCounts.set(kind, count);
        }
        if (this.kindCounts.size === 0 && overview.entities > 0) {
          this.allEntities = await this.client.entities();
          for (const entity of this.allEntities) {
            const kind = entity.kind || "Unknown";
            this.kindCounts.set(kind, (this.kindCounts.get(kind) ?? 0) + 1);
          }
        }
        if (this.kindCounts.size === 0) {
          return [graphEmptyNode()];
        }
      } catch (err) {
        logError("Failed to load entity overview", err);
        return [graphUnavailableNode()];
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

function graphNotIndexedNode(): InfoNode {
  return {
    type: "info",
    message: "Graph not indexed yet",
    tooltip:
      "Kin has not indexed this workspace yet. Run Kin: Setup Workspace or wait for the daemon to finish indexing, then refresh.",
  };
}

function graphEmptyNode(): InfoNode {
  return {
    type: "info",
    message: "No entities found",
    tooltip:
      "The Kin graph is reachable but reported no entities yet. Indexing may still be in progress — refresh to retry.",
  };
}

function graphUnavailableNode(): InfoNode {
  return {
    type: "info",
    message: "Kin graph unavailable",
    tooltip:
      "Could not reach the Kin graph. Check that the kin binary is installed and the daemon is running, then refresh.",
  };
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
