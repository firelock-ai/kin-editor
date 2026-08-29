// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";
import { BinaryNotFoundError, ParseError } from "./errors";

/**
 * The statuses `kin`'s health engine emits, snake_case exactly as serde writes
 * them (`HealthStatus` in `crates/kin-cli/src/commands/health.rs`), plus one
 * this extension makes itself.
 *
 * `pending` and `degraded` were absent here, so both normalized to `missing`
 * and a warming install rendered as a red cross beside the word Missing. They
 * mean the opposite of missing. `pending` is expected first-run work a correct
 * install is still doing, and `degraded` is ground the host never had. Neither
 * is a fault in the install.
 *
 * `unknown` is not a wire value. It is what an unrecognized status normalizes
 * to, and it exists so the next status kin adds cannot be rendered as a red
 * Missing by an extension too old to know it. That is the same defect one
 * layer down, and it is the one that already happened.
 */
export type HealthStatusValue =
  | "healthy"
  | "missing"
  | "stale"
  | "misconfigured"
  | "pending"
  | "degraded"
  | "unsupported"
  | "unknown";

/**
 * The overall verdict the CLI publishes, snake_case as serde writes it
 * (`HealthVerdict` in the same file).
 *
 * Three values rather than two, because `healthy: false` means two different
 * things and no consumer can tell them apart: an install still warming up on a
 * small host, and an install that is broken.
 */
export type HealthVerdictValue = "ready" | "needs_attention" | "failing";

/**
 * Where {@link HealthReport.verdict} came from.
 *
 * `report` means the CLI published one. The other two mean it did not, and
 * they are separate because the sentence a user should read differs: a CLI too
 * old to publish a verdict wants a kin update, and a CLI publishing a word
 * this extension does not know wants an extension update. Collapsing them
 * would put a false sentence on the screen in the second case.
 */
export type VerdictSource =
  | { kind: "report" }
  | { kind: "absent" }
  | { kind: "unrecognized"; published: string };

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatusValue;
  detail: string;
  platform_note: string | null;
  fixable: boolean;
  manual_fix: string | null;
  /**
   * The status word the CLI actually wrote, carried only when it was not one
   * this extension knows. Without it an `unknown` row could not name what it
   * did not understand, and the user would be told less than the CLI said.
   */
  rawStatus?: string;
}

export interface HealthReport {
  platform: string;
  checks: HealthCheck[];
  /**
   * The boolean the CLI published, read back unchanged.
   *
   * Do not decide a readiness surface from this. It answers "is everything
   * answering at full strength", which cannot separate a warming install from
   * a broken one, and on a CLI built before the roll-up rework it can read
   * true over rows that need attention. Read {@link HealthReport.verdict}.
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
    : "unknown";
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
  const status = normalizeStatus(check.status);
  const normalized: HealthCheck = {
    id: String(check.id ?? ""),
    label: String(check.label ?? check.id ?? ""),
    status,
    detail: String(check.detail ?? ""),
    platform_note: optionalString(check.platform_note),
    fixable: check.fixable === true,
    manual_fix: optionalString(check.manual_fix),
  };
  if (status === "unknown") {
    normalized.rawStatus = String(check.status ?? "");
  }
  return normalized;
}

/**
 * Parse the raw stdout of `kin setup status --json` into a typed
 * {@link HealthReport}. The JSON shape is produced by the CLI health engine
 * (`HealthReport` serialized by serde): `{ platform, checks, healthy, verdict }`.
 *
 * This is intentionally tolerant of missing optional fields but never
 * fabricates a passing check. An unparseable or wrong-shaped payload throws.
 */
export function parseHealthReport(raw: string, command = "setup status"): HealthReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ParseError(command, raw, err instanceof Error ? err : undefined);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.checks)) {
    throw new ParseError(command, raw);
  }

  const checks = parsed.checks.map(normalizeCheck);
  const reportedHealthy =
    typeof parsed.healthy === "boolean" ? parsed.healthy : null;
  const healthy =
    reportedHealthy ?? checks.every((c) => !blocksReadiness(c));

  const verdictSource = readVerdictSource(parsed.verdict);

  return {
    platform: String(parsed.platform ?? "unknown"),
    checks,
    healthy,
    verdict:
      verdictSource.kind === "report"
        ? (String(parsed.verdict) as HealthVerdictValue)
        : deriveVerdict(checks, reportedHealthy),
    verdictSource,
  };
}

/**
 * Decide where the verdict is coming from, without deciding what it is.
 *
 * Absent and unrecognized are kept apart here rather than downstream, because
 * once they are one value no later code can tell the user which update fixes
 * it, and the note a user reads would claim the CLI published nothing when it
 * published a word this extension had never seen.
 */
export function readVerdictSource(raw: unknown): VerdictSource {
  if (raw === null || raw === undefined || String(raw).length === 0) {
    return { kind: "absent" };
  }
  const value = String(raw);
  return KNOWN_VERDICTS.has(value as HealthVerdictValue)
    ? { kind: "report" }
    : { kind: "unrecognized", published: value };
}

/**
 * Work out the verdict a CLI that did not publish a usable one would carry.
 *
 * `healthy` is the fallback the published boolean gives us, and the mapping is
 * exact rather than approximate. The old boolean was
 * `!checks.any(blocks_readiness)`, and the new verdict is `failing` on exactly
 * that condition, so `healthy === false` and `failing` are the same fact in
 * two vocabularies. With failing ruled out the rows decide the rest, by the
 * CLI's own {@link needsAttention} rule.
 *
 * Stopping at `healthy` alone would reproduce the defect the verdict was added
 * to fix: a pre-rework CLI reads `healthy: true` over rows that need
 * attention, and a banner keyed on it says ready while the rows say otherwise.
 * Every surface that shows a derived verdict says it was derived.
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
 * Mirrors the `is_failing` predicate in the Rust health engine. Every other
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
 * platform or the context puts it out of scope, which is exactly
 * `unsupported`. Every other status is a component not answering at full
 * strength, `unknown` included, because a status this extension cannot read is
 * not one it may call healthy.
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

/**
 * What the user can do about these rows.
 *
 * Pending rows are the case worth splitting out: nothing is wrong, nothing is
 * fixable, and telling someone to read the fix on a row that carries none is
 * advice that cannot be taken.
 */
function adviceFor(checks: HealthCheck[]): string {
  if (checks.some((check) => check.fixable)) {
    return "Run kin doctor --fix to apply the repairs it can make.";
  }
  if (checks.length > 0 && checks.every((check) => check.status === "pending")) {
    return "This is work still in flight. Re-check in a moment.";
  }
  return "Each row below carries what it needs.";
}

function sourceNoteFor(source: VerdictSource): string | null {
  switch (source.kind) {
    case "report":
      return null;
    case "absent":
      return "This kin CLI does not publish an overall verdict, so the state above was read from the rows below. Update kin to have it reported directly.";
    case "unrecognized":
      return `This kin CLI published the verdict "${source.published}", which this extension does not recognize, so the state above was read from the rows below. Update the Kin extension.`;
  }
}

/**
 * Compose the readiness banner from a report's verdict and its rows.
 *
 * The verdict decides which sentence is told and the rows decide what it
 * names, so the two are read together rather than one standing in for the
 * other. Where they disagree the disagreement is reported: a roll-up claiming
 * more than its components support is the defect this field exists because of,
 * and silently preferring either reading would hide it again.
 */
export function composeReadiness(report: HealthReport): ReadinessLine {
  const attention = report.checks.filter(needsAttention);
  const blocking = report.checks.filter(blocksReadiness);
  const sourceNote = sourceNoteFor(report.verdictSource);

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
    const named = nameRows(cause);
    return {
      verdict: "failing",
      tone: "bad",
      headline: `${cause.length} ${plural(cause.length, "check is", "checks are")} failing: ${named.join(", ")}. Something about this install is wrong, or Kin cannot read the semantic authority here.`,
      advice: adviceFor(cause),
      named,
      sourceNote,
      disagreementNote:
        blocking.length === 0
          ? "The CLI reported failing without a row this extension can name as the cause, so the rows needing attention are named instead."
          : null,
    };
  }

  const named = nameRows(attention);
  return {
    verdict: "needs_attention",
    tone: "warn",
    headline: `${attention.length} ${plural(attention.length, "check needs", "checks need")} attention: ${named.join(", ")}. Nothing about the install is wrong. These parts are not answering at full strength yet.`,
    advice: adviceFor(attention),
    named,
    sourceNote,
    disagreementNote:
      attention.length === 0
        ? "The CLI reported needs_attention while every row below is healthy or does not apply here."
        : null,
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Resolve the `kin` binary the same way {@link KinClient} does:
 * `kin.binaryPath` setting, then `~/.kin/bin/kin`, then bare `kin` on PATH.
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
 * Every reported state comes straight from the real CLI health engine. The
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
