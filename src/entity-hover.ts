// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// What the hover over a `kin://` entity document says. Pure markdown assembly,
// so the wording is asserted directly rather than through an editor.
//
// The rule this file follows: an absence and a failure never share a sentence.
// "No incoming relations" is a claim about the code; "the relations read did
// not answer" is a claim about this session. Collapsing them is how a viewer
// tells a user their function has no callers when the daemon simply timed out.

import type { EntityProvenance, EntityView } from "./graph-entity";
import { describeRelation } from "./graph-relations";
import type { GraphRelation } from "./graph-relations";
import type { GraphFinding } from "./graph-findings";

/** The Markdown a hover over an entity document renders. */
export function renderEntityHover(view: EntityView): string {
  const document = view.document;
  const sections: string[] = [];

  sections.push(`**${document.name}** · ${document.kind}`);

  if (document.signature) {
    sections.push(
      ["```" + (document.language ?? ""), document.signature, "```"].join("\n")
    );
  }

  const span = describeSpan(view);
  if (span) {
    sections.push(span);
  }

  const provenance = describeProvenance(document.provenance);
  if (provenance) {
    sections.push(provenance);
  }

  sections.push(describeRelations(view));

  if (document.truncated) {
    sections.push(
      "**This body is truncated.** The daemon cut it and marked the cut, so the document above is not the whole entity."
    );
  }

  if (view.findings.length > 0) {
    sections.push(describeFindings(view.findings));
  }

  return sections.join("\n\n");
}

function describeSpan(view: EntityView): string | undefined {
  const { startLine, endLine } = view.document;
  if (startLine === undefined) {
    return undefined;
  }
  if (endLine === undefined || endLine === startLine) {
    return `Graph span: line ${startLine}.`;
  }
  return `Graph span: lines ${startLine} to ${endLine}.`;
}

/**
 * Where these bytes came from.
 *
 * No file path here, by the founder's "entities never paths" ruling: an entity
 * is named by its name and kind, and what a reader needs beyond that is whether
 * the bytes are committed or uncommitted and whether the span was proven to
 * describe them. The artifact id is the graph's own handle for the content, and
 * `kin_artifact_read` takes it, so it is the addressable fact a path would
 * otherwise stand in for.
 */
function describeProvenance(provenance: EntityProvenance): string | undefined {
  const parts: string[] = [];
  if (provenance.sourceState) {
    parts.push(`Source state: ${provenance.sourceState}`);
  }
  if (provenance.changeId) {
    parts.push(`Change: ${provenance.changeId}`);
  }
  if (provenance.workspaceGeneration !== undefined) {
    parts.push(
      `Uncommitted working-tree bytes at workspace generation ${provenance.workspaceGeneration}`
    );
  }
  if (provenance.spanCoherence) {
    parts.push(`Span coherence: ${provenance.spanCoherence}`);
  }
  if (provenance.artifactId) {
    parts.push(`Artifact: ${provenance.artifactId}`);
  }
  if (provenance.readVia && provenance.readVia !== "graph") {
    parts.push(`Read via: ${provenance.readVia}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function describeRelations(view: EntityView): string {
  const neighborhood = view.neighborhood;
  if (!neighborhood) {
    return (
      "**Relations**\n\n" +
      "The relations read did not answer for this entity, so nothing is listed here. " +
      "That is a gap in this session, not a claim that the entity has no relations."
    );
  }

  const outgoing = neighborhood.relations.filter(
    (relation) => relation.direction === "outgoing"
  );
  const incoming = neighborhood.relations.filter(
    (relation) => relation.direction === "incoming"
  );

  const lines: string[] = ["**Relations**"];
  lines.push(renderDirection("Depends on", outgoing));
  lines.push(renderDirection("Used by", incoming));

  if (neighborhood.truncated) {
    lines.push(
      "The daemon capped this walk, so the lists above are a floor rather than the whole set."
    );
  }
  return lines.join("\n\n");
}

function renderDirection(
  heading: string,
  relations: readonly GraphRelation[]
): string {
  if (relations.length === 0) {
    return `${heading}: the graph holds none.`;
  }
  const rendered = relations
    .slice(0, 12)
    .map((relation) => `- ${describeRelation(relation)}`)
    .join("\n");
  const more =
    relations.length > 12
      ? `\n- and ${relations.length - 12} more`
      : "";
  return `${heading}:\n${rendered}${more}`;
}

function describeFindings(findings: readonly GraphFinding[]): string {
  const worst = findings[0];
  const lines = [
    `**What the graph disclosed** (${findings.length} finding${findings.length === 1 ? "" : "s"}, most severe first)`,
    ...findings.slice(0, 5).map((finding) => `- ${finding.message}`),
  ];
  if (findings.length > 5) {
    lines.push(`- and ${findings.length - 5} more, listed in the Problems panel`);
  }
  if (worst.severity === "error") {
    lines.push(
      "Read the body above knowing the graph reported an error condition on the answer that produced it."
    );
  }
  return lines.join("\n");
}
