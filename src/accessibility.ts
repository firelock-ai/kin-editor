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
  // Drift is checked before reachability, because a drifted answer IS a
  // reachable runtime. Showing "unavailable" here would send the user to check
  // a binary that is running perfectly well.
  if (status.contractDrift) {
    return "$(warning) Kin: version mismatch";
  }
  if (status.reachable === false) {
    return "$(graph) Kin: unavailable";
  }
  return status.initialized
    ? `$(graph) Kin: ${status.entityCount} entities`
    : "$(graph) Kin: not initialized";
}

export function formatStatusBarTooltip(status: KinStatus): string {
  if (status.contractDrift) {
    return formatContractDriftMessage(status.contractDrift);
  }
  if (status.reachable === false) {
    return "Kin status. The Kin runtime could not be reached. Check that the kin binary is installed and the daemon can start. Click to open the overview.";
  }
  return status.initialized
    ? `Kin status. ${status.entityCount} entities indexed. Click to open the overview.`
    : "Kin status. This workspace is not initialized yet. Click to open the overview.";
}

/**
 * The user-facing sentence for a drifted CLI. It names the command and the keys
 * that went missing, because "something is wrong" is not actionable and a user
 * cannot tell from inside the editor which of the two sides moved.
 */
export function formatContractDriftMessage(
  drift: NonNullable<KinStatus["contractDrift"]>
): string {
  const schema = drift.schema ? ` The CLI published contract ${drift.schema}.` : "";
  return (
    `Kin status. The kin CLI answered \`kin ${drift.command} --json\` in a shape this ` +
    `extension cannot read, so no graph state is shown. Missing: ` +
    `${drift.missing.join(", ")}.${schema} Update the Kin VS Code extension, or update ` +
    `the kin CLI, so the two agree.`
  );
}

export function formatOverviewMessage(overview: KinOverview): string {
  // Distinguish every non-happy graph state honestly instead of presenting
  // fabricated zeros as a real graph. Each state gets its own recovery hint.
  switch (overview.availability) {
    case "contract-drift":
      return "the kin CLI answered in a shape this extension cannot read, so no graph state is shown. This is a version mismatch, not an empty graph. Update the Kin VS Code extension, or update the kin CLI, so the two agree.";
    case "not-indexed":
      return "graph not indexed yet — open the workspace setup to index it, or wait for the daemon to finish.";
    case "unavailable":
      return "graph unavailable — the Kin daemon could not be reached. Check that kin is installed and running, then retry.";
    case "invalid-response":
      return "graph returned an unreadable response — the daemon replied with data Kin could not parse. This is a broken or still-starting daemon, not an empty graph. Retry, or check the daemon logs.";
    case "empty":
      return "no entities indexed yet — the graph is empty or still indexing.";
    case "indexed":
      break;
  }

  // The kin_graph_status MCP tool only guarantees entity_count; edge_count,
  // file_count, and kinds are populated when the daemon reports them.  Omit
  // fields that would show fabricated zeros so the UI stays honest.
  const parts: string[] = [`Entities: ${overview.entities}`];

  if (overview.edges > 0) {
    parts.push(`Edges: ${overview.edges}`);
  }
  if (overview.files > 0) {
    parts.push(`Files: ${overview.files}`);
  }

  const kindEntries = Object.entries(overview.kinds);
  if (kindEntries.length > 0) {
    const kindSummary = kindEntries
      .map(([kind, count]) => `${kind}(${count})`)
      .join(", ");
    parts.push(`Kinds: ${kindSummary}`);
  }

  let message = parts.join(" | ");
  if (overview.compatFallback) {
    // The MCP graph path was expected but a call failed and the CLI answered.
    // Surface the degraded state rather than passing it off as the graph path.
    message += " (via CLI compatibility fallback — MCP graph path unavailable)";
  }
  return message;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
