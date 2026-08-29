// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// The first run a stranger gets.
//
// Coldwalk 2026-08-28 finding 24: installing this extension into a folder with
// no Kin store produced an empty panel, no explanation and no next step. The
// manifest contributed neither of the two mechanisms an editor gives you for
// this, so the eight good commands were reachable only by someone who already
// knew to look for them.
//
// What lives here is the part that is code rather than manifest: the context
// key the welcome view keys on, the streamed `kin init`, and the pure
// functions that decide what a user is told. Everything a user reads is either
// a locked line from the brand canon or the CLI's own words, quoted.

import { spawn } from "child_process";

/**
 * The walkthrough's id in `contributes.walkthroughs`.
 *
 * The value VS Code wants to open one is `<extension id>#<this>`, and the
 * extension id is read from the running extension rather than written down
 * twice. `walkthroughTarget` is the only place the two are joined.
 */
export const WALKTHROUGH_ID = "kinFirstRun";

/**
 * The context key `viewsWelcome` keys its `when` clauses on.
 *
 * Unset reads as false, which is the right default: before activation has
 * looked, this workspace is not known to have a graph.
 */
export const CONTEXT_INITIALIZED = "kin.initialized";

/** Global-state key recording that the first-run offer has been made once. */
export const FIRST_RUN_OFFERED_KEY = "kin.firstRunOffered";

/**
 * The one-time offer shown when Kin activates in a folder with no graph.
 *
 * Two locked lines from the brand canon, verbatim, plus the fact about this
 * folder. A surface needing a headline takes a canon line and does not get a
 * new one.
 */
export const FIRST_RUN_OFFER =
  "Software that remembers itself. Git shows which lines changed. Kin shows what the change affects. This folder has no Kin graph yet.";

/** The action on the first-run offer that opens the walkthrough. */
export const FIRST_RUN_ACTION = "Start here";

/** The action on the first-run offer that dismisses it. */
export const FIRST_RUN_DISMISS = "Not now";

/** How much of the CLI's last line a notification quotes before it says it cut it. */
export const QUOTE_LIMIT = 240;

/** The full walkthrough target VS Code opens, joined from the live extension id. */
export function walkthroughTarget(extensionId: string): string {
  return `${extensionId}#${WALKTHROUGH_ID}`;
}

/** What activation knows about this window when it decides whether to offer. */
export interface FirstRunState {
  hasWorkspaceFolder: boolean;
  /** How many open folders already carry a Kin graph. */
  kinFolderCount: number;
  /** Whether the offer has already been made on this machine. */
  alreadyOffered: boolean;
}

/**
 * Whether to make the one-time first-run offer.
 *
 * Once per machine rather than once per workspace, because the walkthrough
 * stays in Get Started and the welcome view stays in the panel, so a second
 * notification would be a nag rather than a next step. A window with no folder
 * open is not offered anything: there is nothing to initialize, and the
 * commands already answer that case for themselves.
 */
export function shouldOfferFirstRun(state: FirstRunState): boolean {
  return (
    state.hasWorkspaceFolder &&
    state.kinFolderCount === 0 &&
    !state.alreadyOffered
  );
}

/** One line the CLI wrote, tagged with the stream it came out of. */
export interface InitLine {
  stream: "stdout" | "stderr";
  text: string;
}

/** What `kin init` did, as observed rather than as interpreted. */
export interface InitOutcome {
  /** True only on a zero exit. A signalled process is never ok. */
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  /** Every line the CLI wrote, both streams, in arrival order. */
  lines: InitLine[];
}

/** What to put in front of the user once `kin init` has finished. */
export interface InitSummary {
  tone: "info" | "error";
  message: string;
}

function lastNonEmpty(lines: InitLine[], stream?: "stdout" | "stderr"): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (stream && line.stream !== stream) {
      continue;
    }
    if (line.text.trim().length > 0) {
      return line.text.trim();
    }
  }
  return null;
}

function quote(text: string): string {
  if (text.length <= QUOTE_LIMIT) {
    return text;
  }
  return `${text.slice(0, QUOTE_LIMIT)} (cut here, full output is in the Kin output channel)`;
}

/**
 * Say what happened in the CLI's own words.
 *
 * A refusal is quoted rather than described. The extension has no way to know
 * why `kin init` refused, and a sentence written here would be a guess wearing
 * the CLI's authority. When the CLI said nothing, this says it said nothing,
 * which is a fact, rather than inventing a reason.
 *
 * The failing arm reads stderr first because that is where a refusal lands,
 * and falls back to either stream so a CLI that refuses on stdout is still
 * quoted rather than reported as silent.
 */
export function summarizeInit(outcome: InitOutcome): InitSummary {
  if (outcome.ok) {
    const said = lastNonEmpty(outcome.lines);
    return {
      tone: "info",
      message: said
        ? `kin init finished. Last line: ${quote(said)}`
        : "kin init finished and printed nothing.",
    };
  }

  const said = lastNonEmpty(outcome.lines, "stderr") ?? lastNonEmpty(outcome.lines);
  const how =
    outcome.signal !== null
      ? `kin init was stopped by ${outcome.signal}.`
      : `kin init exited ${outcome.exitCode ?? "with no code"}.`;
  return {
    tone: "error",
    message: said ? `${how} Last line: ${quote(said)}` : `${how} It printed nothing.`,
  };
}

/**
 * Run `kin init` and hand every line to `onLine` as it arrives.
 *
 * Streaming rather than buffering because the CLI's progress IS the first-run
 * experience on a repository large enough to take a while: a spinner with no
 * words cannot tell a working init from a stuck one, and the coldwalk's
 * complaint about this extension was exactly that silence.
 *
 * Never rejects on a nonzero exit. A refusal is an outcome to report, not an
 * exception to describe, and the one thing that must not happen is the CLI's
 * own text being replaced by a message written here. It rejects only when the
 * process could not be started at all.
 */
export function runKinInit(
  binary: string,
  cwd: string,
  onLine: (line: InitLine) => void
): Promise<InitOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["init"], { cwd });
    const lines: InitLine[] = [];
    const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

    const take = (stream: "stdout" | "stderr", chunk: string): void => {
      buffers[stream] += chunk;
      const parts = buffers[stream].split(/\r?\n/);
      buffers[stream] = parts.pop() ?? "";
      for (const text of parts) {
        const line: InitLine = { stream, text };
        lines.push(line);
        onLine(line);
      }
    };

    const flush = (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = buffers[stream];
        buffers[stream] = "";
        if (rest.length > 0) {
          const line: InitLine = { stream, text: rest };
          lines.push(line);
          onLine(line);
        }
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => take("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => take("stderr", chunk));

    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      flush();
      resolve({
        ok: code === 0 && signal === null,
        exitCode: code,
        signal: signal ?? null,
        lines,
      });
    });
  });
}
