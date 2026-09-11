// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// The daemon's semantic findings, read out of the answers it already sends.
//
// Every Kin MCP tool result carries a reserved `_kin` envelope beside its
// payload (`crates/kin-mcp/src/envelope.rs`, key `_kin`), and `kin_graph_status`
// answers with the `kin.graph-status.v1` report. Between them they publish what
// the graph could not do for this answer: degraded producers, an enrichment
// sweep that did not finish, call sites the linker parsed and resolved into no
// edge, embeddings still pending, a sample that had to replay an older instant.
//
// Those are findings about the entity you are looking at, so the viewer puts
// them on the entity's own document as diagnostics instead of leaving them in a
// field nobody reads. Nothing here inspects a file: every sentence below is
// built from what the daemon said about its own graph.
//
// Wording rule for this module: a finding restates the daemon's field, and
// where the daemon publishes its own sentence (`note`, `disclosure`, `reason`,
// `limiting_factor`) that sentence is quoted rather than paraphrased. An
// invented explanation for a flag would be a fabrication wearing a diagnostic.

/** How loud a finding is. Maps onto VS Code's diagnostic severities. */
export type FindingSeverity = "error" | "warning" | "info";

/** One thing the graph could not do for this answer. */
export interface GraphFinding {
  /** Stable id, e.g. `degraded.enrichment_shortfall`. Deduped on. */
  code: string;
  severity: FindingSeverity;
  /** One sentence naming the condition and, where the daemon gave one, its scope. */
  message: string;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/**
 * The degraded flags, with the severity each earns and the sentence it gets.
 *
 * Sentences restate the flag's own documented meaning on kin `origin/main` at
 * 8021c785b (`crates/kin-mcp/src/envelope.rs`, `struct Degraded`). A flag this
 * table does not know still becomes a finding, naming itself, because a new
 * degraded condition the extension has not learned about yet is exactly the
 * thing a user needs told.
 */
const DEGRADED_FLAGS: Readonly<
  Record<string, { severity: FindingSeverity; message: string }>
> = {
  daemon_unreachable: {
    severity: "error",
    message:
      "The Kin daemon was required and unreachable, so this answer is a transport error rather than graph-owned truth.",
  },
  no_repository: {
    severity: "error",
    message:
      "Nothing at or above the server's working directory is a Kin repository, so there is no graph to answer from. The remedy is kin init or pointing the server at a repository, not starting a daemon.",
  },
  workspace_mismatch: {
    severity: "error",
    message:
      "The workspace roots name a repository this server does not serve, so the call was refused rather than answered about a different repository.",
  },
  daemon_killed_by_memory: {
    severity: "error",
    message:
      "A daemon serving this store was killed by the memory limit, by the kernel's own accounting.",
  },
  embed_persistence_unavailable: {
    severity: "error",
    message:
      "This graph authority has no durable local vector sidecar, so the embedding worker is intentionally unavailable. Freeing memory cannot clear this.",
  },
  embed_worker_failed: {
    severity: "warning",
    message:
      "The background embedding worker has permanently stopped. The graph still serves; the vector index is frozen until restart.",
  },
  mass_deletion_blocked: {
    severity: "warning",
    message:
      "A suspected mass-deletion wipe is being withheld pending operator confirmation.",
  },
  offline_fallback: {
    severity: "warning",
    message:
      "This answer came from the offline in-process path rather than daemon-owned truth.",
  },
  sweep_suspended: {
    severity: "warning",
    message:
      "Language-server enrichment is switched off by the sweep circuit, so the producer that fills missing cross-file relations is not running.",
  },
  memory_pressure: {
    severity: "warning",
    message:
      "The daemon declined heavy work because the machine had no room for it. The work is owed rather than lost, but until it runs a producer behind part of this answer is not running.",
  },
  relation_census_loss: {
    severity: "warning",
    message:
      "This graph holds fewer relations than its own last verified-good census did, over an entity count that did not fall.",
  },
  hydration_semantics_stale: {
    severity: "warning",
    message:
      "The store's recorded creation-time hydration semantics differ from the ones this binary derives, or the record is absent. Rows here can still be true, but an absence cannot be certified.",
  },
  enrichment_shortfall: {
    severity: "warning",
    message:
      "The last enrichment sweep did not finish the job, so a missing cross-file relation here may be a gap nothing is working on rather than a gap that is not there.",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Turn a snake_case flag into a readable phrase for an unknown flag's sentence. */
function humanize(flag: string): string {
  return flag.replace(/_/g, " ");
}

/**
 * Findings from one tool response's `_kin` envelope.
 *
 * Takes the whole parsed payload, not the envelope alone, because two of the
 * signals live beside it: `edge_coverage` is an additive top-level key the
 * retrieval tools attach, and it is where the parsed-versus-resolved reading
 * lives.
 */
export function findingsFromPayload(payload: unknown): GraphFinding[] {
  if (!isRecord(payload)) {
    return [];
  }
  const findings: GraphFinding[] = [];
  const envelope = isRecord(payload._kin) ? payload._kin : undefined;

  if (envelope) {
    findings.push(...degradedFindings(envelope.degraded));
    findings.push(...verdictFindings(envelope.verdict));
    findings.push(...completenessFindings(envelope.completeness));
    findings.push(...coverageFindings(envelope.semantic_coverage));
    findings.push(...behindFindings(envelope.behind));
    findings.push(...freshnessFindings(envelope.freshness));
    findings.push(...watcherLossFindings(envelope.watcher_loss));
  }

  findings.push(...edgeCoverageFindings(payload.edge_coverage));
  return dedupeFindings(findings);
}

function degradedFindings(degraded: unknown): GraphFinding[] {
  if (!isRecord(degraded)) {
    return [];
  }
  const findings: GraphFinding[] = [];
  for (const [flag, value] of Object.entries(degraded)) {
    // Only an affirmative `true` is a finding. The daemon writes each flag as
    // `Some(bool)` and omits it when it could not determine the condition, so
    // `false` is "observed and fine" and absent is "not observed".
    if (value !== true) {
      continue;
    }
    const known = DEGRADED_FLAGS[flag];
    findings.push({
      code: `degraded.${flag}`,
      severity: known?.severity ?? "warning",
      message:
        known?.message ??
        `The Kin daemon set the degraded flag "${humanize(flag)}" on this answer. This build of the extension does not carry a description for it; the daemon's own documentation for that flag is the record.`,
    });
  }
  return findings;
}

function verdictFindings(verdict: unknown): GraphFinding[] {
  if (!isRecord(verdict)) {
    return [];
  }
  const state = str(verdict.state);
  if (!state || state === "conclusive") {
    return [];
  }
  const limiting = str(verdict.limiting_factor);
  const note = str(verdict.note);
  const detail = limiting ?? note;
  return [
    {
      code: `verdict.${state}`,
      // The envelope's own instruction is that an inconclusive verdict means
      // the counts are a lower bound and an absence in the answer must not be
      // acted on. That is a warning, not a note.
      severity: state === "inconclusive" ? "warning" : "info",
      message:
        `Kin's verdict for this answer is "${state}", so treat what it contains as a lower bound and do not read an absence as proof.` +
        (detail ? ` ${detail}` : ""),
    },
  ];
}

function completenessFindings(completeness: unknown): GraphFinding[] {
  if (!isRecord(completeness)) {
    return [];
  }
  const status = str(completeness.status);
  const bound = str(completeness.bound);
  if (status === "complete" && bound === "exact") {
    return [];
  }
  const note = str(completeness.note);
  const limits = Array.isArray(completeness.limits)
    ? completeness.limits.filter((limit): limit is string => typeof limit === "string")
    : [];
  const detail = note ?? (limits.length > 0 ? `Limited by: ${limits.join(", ")}.` : undefined);
  return [
    {
      code: `completeness.${status ?? "unknown"}`,
      severity: "warning",
      message:
        `This answer is ${status ?? "not complete"} and its counts are a ${bound ?? "floor"} rather than an exact figure.` +
        (detail ? ` ${detail}` : ""),
    },
  ];
}

function coverageFindings(coverage: unknown): GraphFinding[] {
  if (!isRecord(coverage)) {
    return [];
  }
  const pending = num(coverage.pending) ?? 0;
  const complete = coverage.complete === true;
  if (complete && pending === 0) {
    return [];
  }
  const indexed = num(coverage.indexed);
  const total = num(coverage.total);
  const limitedBy = Array.isArray(coverage.limited_by)
    ? coverage.limited_by.filter((limit): limit is string => typeof limit === "string")
    : [];
  const counts =
    indexed !== undefined && total !== undefined
      ? ` ${indexed} of ${total} embedded, ${pending} pending.`
      : ` ${pending} pending.`;
  return [
    {
      code: "semantic_coverage.incomplete",
      severity: "info",
      message:
        `Semantic coverage over this graph is incomplete, so retrieval saw less than the whole repository.${counts}` +
        (limitedBy.length > 0 ? ` Limited by: ${limitedBy.join(", ")}.` : ""),
    },
  ];
}

function behindFindings(behind: unknown): GraphFinding[] {
  if (!isRecord(behind)) {
    return [];
  }
  const unadmitted = num(behind.unadmitted_paths) ?? 0;
  if (unadmitted === 0) {
    return [];
  }
  const note = str(behind.note);
  const sample = Array.isArray(behind.sample)
    ? behind.sample.filter((entry): entry is string => typeof entry === "string")
    : [];
  return [
    {
      code: "behind.unadmitted_paths",
      severity: "warning",
      message:
        `Graph truth is behind the working copy: ${unadmitted} path${unadmitted === 1 ? "" : "s"} the graph never took.` +
        (note ? ` ${note}` : "") +
        (sample.length > 0 ? ` For example: ${sample.slice(0, 3).join(", ")}.` : ""),
    },
  ];
}

function freshnessFindings(freshness: unknown): GraphFinding[] {
  if (!isRecord(freshness)) {
    return [];
  }
  const state = str(freshness.state);
  if (!state || state === "recorded") {
    return [];
  }
  if (state === "no_admission_recorded") {
    return [
      {
        code: "freshness.no_admission_recorded",
        severity: "warning",
        message:
          "This daemon reports no complete admission of the repository into graph truth, so how far the graph is behind the working tree is unmeasured and this answer cannot be read as covering current code.",
      },
    ];
  }
  if (state === "stale") {
    const reason = str(freshness.reason);
    const age = num(freshness.settled_age_ms);
    const attempts = num(freshness.live_attempts);
    return [
      {
        code: "freshness.stale",
        severity: "warning",
        message:
          `The selected graph could not be sampled live${attempts !== undefined ? ` after ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}` +
          `${reason ? ` because ${reason}` : ""}, so these counters replay an earlier observation` +
          `${age !== undefined ? ` from ${age} ms earlier` : ""}.`,
      },
    ];
  }
  return [
    {
      code: `freshness.${state}`,
      severity: "warning",
      message: `Kin reported graph freshness state "${humanize(state)}" for this answer.`,
    },
  ];
}

function watcherLossFindings(loss: unknown): GraphFinding[] {
  if (!isRecord(loss)) {
    return [];
  }
  const disclosure = str(loss.disclosure);
  const generation = num(loss.generation);
  return [
    {
      code: "watcher_loss",
      severity: "warning",
      message:
        `The watcher that feeds graph truth admits it lost events${generation !== undefined ? ` at generation ${generation}` : ""}, so changes made while it was blind may be missing from this answer.` +
        (disclosure ? ` ${disclosure}` : ""),
    },
  ];
}

/**
 * Dangling references, read from the additive `edge_coverage` observation.
 *
 * Two different facts live here and they must not share a word. A class whose
 * state is `unproduced` is a statement about the BUILD: the sites are in the
 * source, the linker saw them, and no entity-level edge came out. The
 * `reference_resolution` counts are the measured version of the same thing:
 * call sites the parser counted against call edges the linker resolved. Both
 * mean a reference this entity really has may be missing from the graph, which
 * is the one thing a reader of a Kin answer has to know.
 */
function edgeCoverageFindings(coverage: unknown): GraphFinding[] {
  if (!isRecord(coverage)) {
    return [];
  }
  const findings: GraphFinding[] = [];
  const language = str(coverage.language);
  const scope = language ? ` for ${language}` : "";

  const classes = isRecord(coverage.classes) ? coverage.classes : undefined;
  if (classes) {
    for (const [className, entry] of Object.entries(classes)) {
      const state = isRecord(entry) ? str(entry.state) : str(entry);
      if (state !== "unproduced") {
        continue;
      }
      findings.push({
        code: `edge_coverage.unproduced.${className}`,
        severity: "warning",
        message:
          `Kin found no ${className} edge in the graph${scope} even though the parse side shows ${className} sites the linker resolved into nothing. ` +
          `This is a gap in the build, not a statement that the code has no ${className} references, so a reference this entity has may be missing here.`,
      });
    }
  }

  const resolution = isRecord(coverage.reference_resolution)
    ? coverage.reference_resolution
    : undefined;
  if (resolution) {
    const parsedCalls = num(resolution.parsed_call_sites);
    const resolvedCalls = num(resolution.resolved_call_edges);
    if (
      parsedCalls !== undefined &&
      resolvedCalls !== undefined &&
      parsedCalls > resolvedCalls
    ) {
      findings.push({
        code: "edge_coverage.dangling_calls",
        severity: "warning",
        message:
          `${resolvedCalls} of ${parsedCalls} parsed call sites${scope} resolved into a graph edge, so ${parsedCalls - resolvedCalls} call site${parsedCalls - resolvedCalls === 1 ? "" : "s"} the parser saw reach nothing in the graph.`,
      });
    }
    const parsedImports = num(resolution.parsed_import_statements);
    const resolvedImports = num(resolution.resolved_import_statements);
    if (
      parsedImports !== undefined &&
      resolvedImports !== undefined &&
      parsedImports > resolvedImports
    ) {
      findings.push({
        code: "edge_coverage.dangling_imports",
        severity: "warning",
        message:
          `${resolvedImports} of ${parsedImports} parsed import statements${scope} resolved into a graph edge, so ${parsedImports - resolvedImports} import${parsedImports - resolvedImports === 1 ? "" : "s"} the parser saw reach nothing in the graph.`,
      });
    }
  }

  return findings;
}

/**
 * Findings from a `kin.graph-status.v1` report.
 *
 * This is where unattested enrichment is stated outright: the schema's own
 * `completion_attested` is false by contract, and `kin` refuses to deserialize
 * a report claiming otherwise. The viewer says so once rather than letting a
 * healthy-looking count imply a guarantee the daemon never made.
 */
export function findingsFromGraphStatus(report: unknown): GraphFinding[] {
  if (!isRecord(report)) {
    return [];
  }
  const findings: GraphFinding[] = [];

  if (report.completion_attested === false) {
    findings.push({
      code: "graph_status.completion_unattested",
      severity: "info",
      message:
        "Kin's graph status carries no enrichment-completion attestation: the counts are observations, not a guarantee that every eligible source was enriched.",
    });
  }

  const pending = num(report.embeddings_pending) ?? 0;
  if (pending > 0) {
    const indexed = num(report.embeddings_indexed);
    const total = num(report.embeddings_total);
    findings.push({
      code: "graph_status.embeddings_pending",
      severity: "info",
      message:
        `${pending} embedding${pending === 1 ? " is" : "s are"} still pending` +
        (indexed !== undefined && total !== undefined
          ? `, with ${indexed} of ${total} indexed`
          : "") +
        ", so semantic retrieval has not seen the whole graph yet.",
    });
  }

  const orphanKeys = num(report.embedding_keys_not_in_graph) ?? 0;
  if (orphanKeys > 0) {
    findings.push({
      code: "graph_status.stale_vectors",
      severity: "warning",
      message:
        `${orphanKeys} indexed vector${orphanKeys === 1 ? "" : "s"} belong to entity revisions graph truth no longer admits, so retrieval ranks them and then drops them.`,
    });
  }

  if (str(report.sampling) === "last_settled_selected_graph") {
    const stale = isRecord(report.stale) ? report.stale : undefined;
    const reason = stale ? str(stale.reason) : undefined;
    findings.push({
      code: "graph_status.sample_replayed",
      severity: "info",
      message:
        "These graph counters replay the last settled observation because a live sample could not be taken." +
        (reason ? ` ${reason}` : ""),
    });
  }

  findings.push(...findingsFromPayload(report));
  return dedupeFindings(findings);
}

/**
 * Merge finding lists, keeping one row per code at its worst severity.
 *
 * The viewer reads several tools for one document and they carry overlapping
 * envelopes, so without this a degraded daemon would publish the same sentence
 * three times on one line and train the reader to ignore the gutter.
 */
export function dedupeFindings(
  ...lists: readonly (readonly GraphFinding[])[]
): GraphFinding[] {
  const byCode = new Map<string, GraphFinding>();
  for (const list of lists) {
    for (const finding of list) {
      const existing = byCode.get(finding.code);
      if (
        !existing ||
        SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]
      ) {
        byCode.set(finding.code, finding);
      }
    }
  }
  return [...byCode.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return bySeverity !== 0 ? bySeverity : a.code.localeCompare(b.code);
  });
}
