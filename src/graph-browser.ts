// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// The graph browser: the entity tree, organised the way the graph names things
// rather than the way a folder does.
//
// Two levels above the entities, namespace then kind, both read from what the
// graph published. No path is in the tree at any level, and an entity whose
// graph name carries no namespace is grouped under a row that says exactly
// that instead of being filed under the directory it happens to live in. That
// is the founder's "entities never paths" ruling, and it is also the honest
// rendering: the graph did not give those entities a namespace, so neither does
// this.

import * as vscode from "vscode";
import { KinClient, KinEntity } from "./kin-client";
import {
  NamespaceGroup,
  groupByNamespaceAndKind,
  leafName,
  namespaceGroupLabel,
  namespaceGroupTooltip,
} from "./graph-entity";
import {
  graphEmptyNotice,
  graphStateNotice,
  graphUnavailableNotice,
} from "./graph-state-notice";
import {
  formatKindGroupAccessibilityLabel,
  formatKindGroupLabel,
  formatKindGroupTooltip,
} from "./accessibility";
import { logError } from "./logger";

/** The command a tree row fires to open an entity as a `kin://` document. */
export const OPEN_ENTITY_COMMAND = "kin.openEntity";

type BrowserNode = NamespaceNode | KindNode | EntityNode | InfoNode;

interface NamespaceNode {
  type: "namespace";
  group: NamespaceGroup;
}

interface KindNode {
  type: "kind";
  namespace: string | undefined;
  kind: string;
  entities: KinEntity[];
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

export class GraphBrowserProvider
  implements vscode.TreeDataProvider<BrowserNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    BrowserNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: NamespaceGroup[] | undefined;

  constructor(
    private readonly client: KinClient,
    private readonly workspaceKey: string
  ) {}

  refresh(): void {
    this.groups = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BrowserNode): vscode.TreeItem {
    switch (element.type) {
      case "info":
        return infoItem(element);
      case "namespace":
        return namespaceItem(element);
      case "kind":
        return kindItem(element);
      case "entity":
        return this.entityItem(element);
    }
  }

  async getChildren(element?: BrowserNode): Promise<BrowserNode[]> {
    if (!element) {
      return this.rootNodes();
    }
    if (element.type === "namespace") {
      return element.group.kinds.map((kind) => ({
        type: "kind" as const,
        namespace: element.group.namespace,
        kind: kind.kind,
        entities: kind.entities,
      }));
    }
    if (element.type === "kind") {
      return element.entities.map((entity) => ({
        type: "entity" as const,
        entity,
      }));
    }
    return [];
  }

  /**
   * The namespace rows, loaded once per refresh.
   *
   * The overview is asked first because it is the cheap call that distinguishes
   * a warming daemon, a drifted CLI and an unreachable one from a graph that is
   * genuinely empty, and a tree that cannot tell those apart shows a blank
   * panel for all four.
   */
  private async rootNodes(): Promise<BrowserNode[]> {
    if (this.groups) {
      return this.groups.map((group) => ({ type: "namespace" as const, group }));
    }

    let entities: KinEntity[];
    try {
      const overview = await this.client.overview();
      const notice = graphStateNotice(overview.availability);
      if (notice) {
        return [{ type: "info", ...notice }];
      }
      entities = await this.client.entities();
    } catch (err) {
      logError("Graph browser: failed to load entities", err);
      return [{ type: "info", ...graphUnavailableNotice() }];
    }

    if (entities.length === 0) {
      return [{ type: "info", ...graphEmptyNotice() }];
    }

    this.groups = groupByNamespaceAndKind(entities);
    return this.groups.map((group) => ({ type: "namespace" as const, group }));
  }

  private entityItem(element: EntityNode): vscode.TreeItem {
    const entity = element.entity;
    const item = new vscode.TreeItem(
      leafName(entity.name),
      vscode.TreeItemCollapsibleState.None
    );
    item.description = entity.kind;
    item.tooltip = entityTooltip(entity);
    item.contextValue = entity.id ? "kinEntity" : "kinEntityWithoutId";
    item.iconPath = iconForKind(entity.kind);
    item.accessibilityInformation = {
      label: `${entity.kind} ${entity.name}`,
      role: "treeitem",
    };
    // No `resourceUri`. Setting one would hand the row to the editor's file
    // decorations, and a graph row decorated by its file's git status is the
    // file-first reading this tree exists to replace.
    item.command = {
      command: OPEN_ENTITY_COMMAND,
      title: "Open Kin Entity",
      arguments: [{ entity, workspaceKey: this.workspaceKey }],
    };
    return item;
  }
}

/**
 * An entity's tooltip: what the graph knows it as.
 *
 * The signature when there is one, the qualified name when it differs from the
 * row label, and the kind. Deliberately no file and line: the row is an entity,
 * and the document it opens carries the span and the provenance in its hover.
 */
export function entityTooltip(entity: KinEntity): string {
  const lines: string[] = [`${entity.kind} ${entity.name}`];
  if (entity.signature) {
    lines.push(entity.signature);
  }
  if (!entity.id) {
    lines.push(
      "This answer carried no graph id for the entity, so it can be listed but not opened as a graph document."
    );
  }
  return lines.join("\n");
}

function infoItem(element: InfoNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    element.message,
    vscode.TreeItemCollapsibleState.None
  );
  item.contextValue = "kinInfo";
  item.iconPath = new vscode.ThemeIcon("info");
  item.tooltip = element.tooltip;
  item.accessibilityInformation = { label: element.message, role: "treeitem" };
  return item;
}

function namespaceItem(element: NamespaceNode): vscode.TreeItem {
  const group = element.group;
  const item = new vscode.TreeItem(
    namespaceGroupLabel(group),
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.description = `${group.count}`;
  item.contextValue = "kinNamespace";
  item.iconPath = new vscode.ThemeIcon(
    group.namespace ? "symbol-namespace" : "symbol-misc"
  );
  item.tooltip = namespaceGroupTooltip(group);
  item.accessibilityInformation = {
    label: `${namespaceGroupLabel(group)}, ${group.count} ${group.count === 1 ? "entity" : "entities"}`,
    role: "treeitem",
  };
  return item;
}

function kindItem(element: KindNode): vscode.TreeItem {
  const count = element.entities.length;
  const item = new vscode.TreeItem(
    formatKindGroupLabel(element.kind, count),
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.contextValue = "kindGroup";
  item.iconPath = iconForKind(element.kind);
  item.tooltip = formatKindGroupTooltip(element.kind, count);
  item.accessibilityInformation = {
    label: formatKindGroupAccessibilityLabel(element.kind, count),
    role: "treeitem",
  };
  return item;
}

function iconForKind(kind: string): vscode.ThemeIcon {
  const map: Record<string, string> = {
    Function: "symbol-function",
    Class: "symbol-class",
    Module: "symbol-module",
    Package: "symbol-package",
    Method: "symbol-method",
    Interface: "symbol-interface",
    TraitDef: "symbol-interface",
    Struct: "symbol-struct",
    Enum: "symbol-enum",
    EnumDef: "symbol-enum",
    EnumVariant: "symbol-enum-member",
    Variable: "symbol-variable",
    StaticVar: "symbol-variable",
    Constant: "symbol-constant",
    Type: "symbol-type-parameter",
    TypeAlias: "symbol-type-parameter",
    Test: "beaker",
    Macro: "symbol-operator",
    File: "symbol-file",
  };
  return new vscode.ThemeIcon(map[kind] || "symbol-misc");
}
