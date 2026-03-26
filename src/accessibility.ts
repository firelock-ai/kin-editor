// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import type { KinEntity, KinOverview, KinStatus } from "./kin-client";

export function formatKindGroupLabel(kind: string, count: number): string {
  return `${kind} (${count})`;
}

export function formatKindGroupAccessibilityLabel(
  kind: string,
  count: number
): string {
  return `${kind} group with ${count} ${count === 1 ? "entity" : "entities"}`;
}

export function formatKindGroupTooltip(kind: string, count: number): string {
  return `${count} ${kind.toLowerCase()} ${count === 1 ? "entity" : "entities"}`;
}

export function formatEntityDescription(entity: KinEntity): string {
  return `${entity.kind} - ${entity.file}:${entity.line}`;
}

export function formatEntityTooltip(entity: KinEntity): string {
  const lines = [entity.signature || `${entity.kind} ${entity.name}`];
  lines.push(`${entity.file}:${entity.line}`);
  return lines.join("\n");
}

export function formatEntityAccessibilityLabel(entity: KinEntity): string {
  const signature = entity.signature ? ` ${entity.signature}` : "";
  return `${entity.kind} ${entity.name}, ${entity.file} line ${entity.line}${signature}`;
}

export function formatSearchResultLabel(entity: KinEntity): string {
  return entity.name;
}

export function formatSearchResultDescription(entity: KinEntity): string {
  return `${entity.kind} - ${entity.file}:${entity.line}`;
}

export function formatSearchResultDetail(entity: KinEntity): string {
  return entity.signature || entity.kind;
}

export function formatStatusBarText(status: KinStatus): string {
  return status.initialized
    ? `$(graph) Kin: ${status.entityCount} entities`
    : "$(graph) Kin: not initialized";
}

export function formatStatusBarTooltip(status: KinStatus): string {
  return status.initialized
    ? `Kin status. ${status.entityCount} entities indexed. Click to open the overview.`
    : "Kin status. This workspace is not initialized yet. Click to open the overview.";
}

export function formatOverviewMessage(overview: KinOverview): string {
  const kindSummary = Object.entries(overview.kinds)
    .map(([kind, count]) => `${kind}(${count})`)
    .join(", ");
  return [
    `Entities: ${overview.entities}`,
    `Edges: ${overview.edges}`,
    `Files: ${overview.files}`,
    `Kinds: ${kindSummary || "none"}`,
  ].join(" | ");
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
