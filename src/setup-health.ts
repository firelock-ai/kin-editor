// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";
import { BinaryNotFoundError, ParseError } from "./errors";

/**
 * The seven statuses `kin`'s health engine emits, snake_case exactly as serde
 * writes them (`HealthStatus` in `crates/kin-cli/src/commands/health.rs`).
 *
 * `pending` and `degraded` arrived with the roll-up rework and were absent
 * here, so both normalized to `missing` and a warming install rendered as a red
 * cross beside the word Missing. They mean the opposite of missing: `pending`
 * is expected first-run work a correct install is still doing, and `degraded`
 * is ground the host never had. Neither is a fault in the install.
 */
export type HealthStatusValue =
  | "healthy"
  | "missing"
  | "stale"
  | "misconfigured"
  | "pending"
  | "degraded"
  | "unsupported";

/**
 * The overall verdict the CLI now carries, snake_case as serde writes it
 * (`HealthVerdict` in the same file).
 *
 * Three values rather than two because `healthy: false` means two different
 * things and no consumer can tell them apart: an install still warming up on a
 * small host, and an install that is broken.
 */
export type HealthVerdictValue = "ready" | "needs_attention" | "failing";

/**
 * Where {@link HealthReport.verdict} came from.
 *
 * `report` means the CLI published one. `derived` means it did not, which is
 * every CLI built before the verdict landed, and this extension worked the
 * verdict out from the rows. Users run mixed versions, so the difference is
 * shown rather than smoothed over.
 */
export type VerdictSource = "report" | "derived";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatusValue;
  detail: string;
  platform_note: string | null;
  fixable: boolean;
  manual_fix: string | null;
}

export interface HealthReport {
  platform: string;
  checks: HealthCheck[];
  /**
   * The boolean the CLI published, read back unchanged.
   *
   * Do not decide a readiness surface from this. It answers "is everything
   * answering at full strength", which cannot separate a warming install from a
   * broken one, and on a CLI built before the roll-up rework it can read true
   * over rows that need attention. Read {@link HealthReport.verdict}.
   */
  healthy: boolean;
  /** The overall verdict every readiness surface reads. */
  verdict: HealthVerdictValue;
  /** Whether {@link HealthReport.verdict} was published or worked out here. */
  verdictSource: VerdictSource;
}

const KNOWN_STATUSES: ReadonlySet<HealthStatusValue> = new Set([
  "healthy",
  "missing",
  "stale",
  "misconfigured",
  "pending",
  "degraded",
  "unsupported",
]);

const KNOWN_VERDICTS: ReadonlySet<HealthVerdictValue> = new Set([
  "ready",
  "needs_attention",
  "failing",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStatus(raw: unknown): HealthStatusValue {
  const value = String(raw ?? "").toLowerCase();
  return KNOWN_STATUSES.has(value as HealthStatusValue)
    ? (value as HealthStatusValue)
    : "missing";
}

function optionalString(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const str = String(raw);
  return str.length > 0 ? str : null;
}

function normalizeCheck(raw: unknown): HealthCheck {
  const check = isRecord(raw) ? raw : {};
  return {
    id: String(check.id ?? ""),
    label: String(check.label ?? check.id ?? ""),
    status: normalizeStatus(check.status),
    detail: String(check.detail ?? ""),
    platform_note: optionalString(check.platform_note),
    fixable: check.fixable === true,
    manual_fix: optionalString(check.manual_fix),
  };
}

/**
 * Parse the raw stdout of `kin setup status --json` into a typed
 * {@link HealthReport}. The JSON shape is produced by the CLI health engine
 * (`HealthReport` serialized by serde): `{ platform, checks, healthy, verdict }`.
 *
 * This is intentionally tolerant of missing optional fields but never
 * fabricates a passing check — an unparseable or wrong-shaped payload throws.
 */
export function parseHealthReport(raw: string, command = "setup status"): HealthReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ParseError(command, raw, err instanceof Error ? err : undefined);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.checks)) {
    throw new ParseError(
      command,
      raw,
      new Error("expected an object with a 'checks' array")
    );
  }

  const checks = parsed.checks.map(normalizeCheck);
  const reportedHealthy =
    typeof parsed.healthy === "boolean" ? parsed.healthy : null;
  const healthy =
    reportedHealthy ?? checks.every((c) => !blocksReadiness(c));

  const publishedVerdict = readVerdict(parsed.verdict);

  return {
    platform: String(parsed.platform ?? "unknown"),
    checks,
    healthy,
    verdict: publishedVerdict ?? deriveVerdict(checks, reportedHealthy),
    verdictSource: publishedVerdict ? "report" : "derived",
  };
}

function readVerdict(raw: unknown): HealthVerdictValue | null {
  const value = String(raw ?? "").toLowerCase();
  return KNOWN_VERDICTS.has(value as HealthVerdictValue)
    ? (value as HealthVerdictValue)
    : null;
}

/**
 * Work out the verdict a CLI too old to publish one would have carried.
 *
 * The mapping is exact rather than approximate, which is why it is worth doing
 * instead of falling back to `healthy` alone. The old boolean was
 * `!checks.any(blocks_readiness)`, and the new verdict is `failing` on exactly
 * that condition, so `healthy === false` and `failing` are the same fact in two
 * vocabularies. With failing ruled out, the rows decide the rest, and the rule
 * they decide it by is the CLI's own {@link needsAttention}.
 *
 * Falling back to `healthy` on its own would reproduce the defect the verdict
 * was added to fix: a pre-rework CLI reads `healthy: true` over rows that need
 * attention, and a banner keyed on it says ready while the rows say otherwise.
 */
export function deriveVerdict(
  checks: HealthCheck[],
  reportedHealthy: boolean | null
): HealthVerdictValue {
  const failing =
    reportedHealthy === null ? checks.some(blocksReadiness) : !reportedHealthy;
  if (failing) {
    return "failing";
  }
  return checks.some(needsAttention) ? "needs_attention" : "ready";
}

/**
 * A check "fails" the overall report when it is missing or misconfigured.
 * Mirrors the `is_failing` predicate in the Rust health engine; every other
 * status is surfaced but does not on its own mean the install is broken.
 */
export function isFailing(status: HealthStatusValue): boolean {
  return status === "missing" || status === "misconfigured";
}

/**
 * Whether a check names something wrong with the INSTALL.
 *
 * Mirrors `blocks_readiness` in the Rust health engine, including the one
 * id-specific arm: semantic readiness is an authority gate, so a stale
 * `semantic_query_readiness` row means the semantic surface cannot honestly be
 * called ready, while stale anywhere else stays advisory.
 */
export function blocksReadiness(check: HealthCheck): boolean {
  return (
    isFailing(check.status) ||
    (check.id === "semantic_query_readiness" && check.status === "stale")
  );
}

/**
 * Whether a check keeps the report out of `ready`.
 *
 * Mirrors `needs_attention` in the Rust health engine, which is the one rule
 * the whole roll-up is built from: a check is out of scope only when the
 * platform or the context puts it out of scope, which is exactly `unsupported`.
 * Every other status is a component not answering at full strength.
 */
export function needsAttention(check: HealthCheck): boolean {
  return check.status !== "healthy" && check.status !== "unsupported";
}

/** Whether the user should be offered the `kin doctor --fix` action. */
export function hasFixableChecks(report: HealthReport): boolean {
  return report.checks.some(
    (c) => c.fixable && c.status !== "healthy"
  );
}

/** How many rows a readiness line names before it counts the rest. */
const NAMED = 4;

/**
 * One readiness reading of a health report, ready to render.
 *
 * Every field answers a question the user has: which state this is, what is
 * happening, which rows it is about, and what to do next. A state that named
 * none of those is what a bare `healthy` boolean gave, and it is why a warming
 * install and a broken one looked the same.
 */
export interface ReadinessLine {
  verdict: HealthVerdictValue;
  /** Banner styling class: green, yellow, red. */
  tone: "ok" | "warn" | "bad";
  /** What is happening, with the rows it is about named. */
  headline: string;
  /** What the user can do about it. Never empty. */
  advice: string;
  /** The rows this verdict is about, truncated with an "and N more" tail. */
  named: string[];
  /** Stated when the verdict was worked out here rather than published. */
  sourceNote: string | null;
  /** Stated when the published verdict and the rows below it disagree. */
  disagreementNote: string | null;
}

function nameRows(checks: HealthCheck[]): string[] {
  const labels = checks.slice(0, NAMED).map((check) => check.label);
  if (checks.length > NAMED) {
    labels.push(`and ${checks.length - NAMED} more`);
  }
  return labels;
}

function adviceFor(checks: HealthCheck[]): string {
  return checks.some((check) => check.fixable)
    ? "Run `kin doctor --fix` to apply the safe repairs."
    : "Each row below carries the fix it needs.";
}

/**
 * Compose the readiness banner from a report's verdict and its rows.
 *
 * The verdict decides which sentence is told and the rows decide what it names,
 * so the two are read together rather than one standing in for the other. Where
 * they disagree the disagreement is reported: a roll-up claiming more than its
 * components support is the defect this field exists because of, and silently
 * preferring either reading would hide it again.
 */
export function composeReadiness(report: HealthReport): ReadinessLine {
  const attention = report.checks.filter(needsAttention);
  const blocking = report.checks.filter(blocksReadiness);

  const sourceNote =
    report.verdictSource === "derived"
      ? "This kin CLI does not publish an overall verdict, so the state above was read from the rows below. Update kin to have it reported directly."
      : null;

  if (report.verdict === "ready") {
    return {
      verdict: "ready",
      tone: "ok",
      headline:
        "Kin is ready in this workspace. Every check that applies here is healthy.",
      advice: "Run Kin: Semantic Search to ask the graph a question.",
      named: [],
      sourceNote,
      disagreementNote:
        attention.length > 0
          ? `The CLI reported ready while ${attention.length} ${plural(attention.length, "row", "rows")} below still ${plural(attention.length, "needs", "need")} attention. Both readings are shown rather than one being chosen for you.`
          : null,
    };
  }

  if (report.verdict === "failing") {
    // Prefer the rows this extension can name as the cause. A CLI that starts
    // failing on a condition not modelled here would otherwise be rendered as
    // "0 checks are failing", so the attention rows stand in and the swap is
    // said out loud.
    const cause = blocking.length > 0 ? blocking : attention;
    const count = cause.length;
    return {
      verdict: "failing",
      tone: "bad",
      headline:
        count === 1
          ? `1 check is failing: ${nameRows(cause).join(", ")}. Kin cannot answer semantic queries in this workspace until it is fixed.`
          : `${count} checks are failing: ${nameRows(cause).join(", ")}. Kin cannot answer semantic queries in this workspace until they are fixed.`,
      advice: adviceFor(cause),
      named: nameRows(cause),
      sourceNote,
      disagreementNote:
        blocking.length === 0
          ? "The CLI reported failing without a row this extension can name as the cause, so the rows needing attention are named instead."
          : null,
    };
  }

  const count = attention.length;
  return {
    verdict: "needs_attention",
    tone: "warn",
    headline:
      count === 1
        ? `1 check needs attention: ${nameRows(attention).join(", ")}. Nothing here is broken and Kin still answers; this part is not at full strength yet.`
        : `${count} checks need attention: ${nameRows(attention).join(", ")}. Nothing here is broken and Kin still answers; these parts are not at full strength yet.`,
    advice: adviceFor(attention),
    named: nameRows(attention),
    sourceNote,
    disagreementNote:
      count === 0
        ? "The CLI reported needs_attention while every row below is healthy or not applicable here."
        : null,
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Resolve the `kin` binary the same way {@link KinClient} does:
 * `kin.binaryPath` setting → `~/.kin/bin/kin` → bare `kin` on PATH.
 */
export function resolveKinBinary(): string {
  const config = vscode.workspace.getConfiguration("kin");
  const configured = config.get<string>("binaryPath");
  if (configured && existsSync(configured)) {
    return configured;
  }
  const homeBin = join(homedir(), ".kin", "bin", "kin");
  if (existsSync(homeBin)) {
    return homeBin;
  }
  return "kin";
}

/**
 * Shell out to `kin setup status --json` and return the parsed health report.
 * Every reported state comes straight from the real CLI health engine — the
 * extension never fabricates a green check.
 */
export function runSetupStatus(
  cwd: string | undefined,
  timeoutMs = 20_000
): Promise<HealthReport> {
  const binary = resolveKinBinary();
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["setup", "status", "--json"],
      { cwd, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          if ("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new BinaryNotFoundError(binary));
            return;
          }
          // `kin setup status` exits 0 even when checks fail, so a non-zero
          // exit with parseable JSON on stdout is still usable; prefer the
          // report when present, otherwise surface the error.
          if (stdout && stdout.trim().startsWith("{")) {
            try {
              resolve(parseHealthReport(stdout));
              return;
            } catch {
              // fall through to error
            }
          }
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          resolve(parseHealthReport(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}
