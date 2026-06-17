// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";
import { BinaryNotFoundError, ParseError } from "./errors";

export type HealthStatusValue =
  | "healthy"
  | "missing"
  | "stale"
  | "misconfigured"
  | "unsupported";

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
  healthy: boolean;
}

const KNOWN_STATUSES: ReadonlySet<HealthStatusValue> = new Set([
  "healthy",
  "missing",
  "stale",
  "misconfigured",
  "unsupported",
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
 * (`HealthReport` serialized by serde): `{ platform, checks, healthy }`.
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
  const healthy =
    typeof parsed.healthy === "boolean"
      ? parsed.healthy
      : checks.every((c) => !isFailing(c.status));

  return {
    platform: String(parsed.platform ?? "unknown"),
    checks,
    healthy,
  };
}

/**
 * A check "fails" the overall report when it is missing or misconfigured.
 * Mirrors the `is_failing` predicate in the Rust health engine; `stale` and
 * `unsupported` are surfaced but do not flip `healthy` to false.
 */
export function isFailing(status: HealthStatusValue): boolean {
  return status === "missing" || status === "misconfigured";
}

/** Whether the user should be offered the `kin doctor --fix` action. */
export function hasFixableChecks(report: HealthReport): boolean {
  return report.checks.some(
    (c) => c.fixable && c.status !== "healthy"
  );
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
