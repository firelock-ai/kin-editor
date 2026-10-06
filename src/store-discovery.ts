// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Which workspace folders Kin serves.
//
// A folder is served when it has a Kin store. The store is usually `.kin`
// inside the folder, and `kin init --store <dir>` can keep it outside the
// folder instead, where only Kin knows how to find it. The extension holds
// no store-location logic of its own: after the fast `.kin` check it asks
// `kin store path --json`, which reads at most two small files and starts
// nothing.

import * as vscode from "vscode";
import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** How long one `kin store path` answer may take before the folder is skipped. */
const STORE_PATH_TIMEOUT_MS = 3_000;

interface StorePathAnswer {
  schema?: string;
  working_dir?: string;
  store?: string;
  external?: boolean;
}

function kinBinary(): string {
  const configured = vscode.workspace.getConfiguration("kin").get<string>("binaryPath");
  if (configured && existsSync(configured)) {
    return configured;
  }
  const homeBin = join(homedir(), ".kin", "bin", "kin");
  if (existsSync(homeBin)) {
    return homeBin;
  }
  return "kin";
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

/**
 * Whether a Kin store serves exactly this folder: its own `.kin`, or a store
 * kept outside it. A store serving an enclosing folder does not count, which
 * matches what a folder's own `.kin` has always meant here.
 */
export function folderHasKinStore(folderPath: string): boolean {
  if (existsSync(join(folderPath, ".kin"))) {
    return true;
  }
  let output: string;
  try {
    output = execFileSync(kinBinary(), ["store", "path", "--json", folderPath], {
      cwd: folderPath,
      encoding: "utf8",
      timeout: STORE_PATH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No store, no `kin` on this machine, or a `kin` older than the command.
    return false;
  }
  try {
    const answer = JSON.parse(output) as StorePathAnswer;
    return (
      answer.schema === "kin.store-path.v1" &&
      typeof answer.working_dir === "string" &&
      samePath(answer.working_dir, folderPath)
    );
  } catch {
    return false;
  }
}
