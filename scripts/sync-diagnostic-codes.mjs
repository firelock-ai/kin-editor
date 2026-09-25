// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Refresh the standalone editor's public MCP vocabulary from a reviewed Kin
// checkout. No source checkout is needed to build or run the extension.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [sourceRoot, ...options] = process.argv.slice(2);
if (!sourceRoot || options.some((option) => option !== "--check")) {
  throw new Error("Usage: node scripts/sync-diagnostic-codes.mjs <kin-checkout> [--check]");
}
const envelope = readFileSync(resolve(sourceRoot, "crates/kin-mcp/src/envelope.rs"), "utf8");
const verdict = readFileSync(resolve(sourceRoot, "crates/kin-mcp/src/verdict.rs"), "utf8");
const version = envelope.match(/pub const ENVELOPE_VERSION:\s*u32\s*=\s*(\d+);/);
const registry = verdict.match(/pub const CLAUSE_CODES:[\s\S]*?=\s*&\[([\s\S]*?)\n\];/);
if (version?.[1] !== "2" || !registry) {
  throw new Error("Review the renderer before importing a changed envelope contract.");
}
const clauses = {};
for (const match of registry[1].matchAll(/code:\s*"([a-z_]+)",\s*meaning:\s*("(?:[^"\\]|\\.)*"),/g)) {
  if (Object.hasOwn(clauses, match[1])) throw new Error(`Duplicate clause: ${match[1]}`);
  clauses[match[1]] = JSON.parse(match[2]);
}
if (Object.keys(clauses).length === 0 ||
    Object.keys(clauses).length !== (registry[1].match(/ClauseCode\s*\{/g) ?? []).length) {
  throw new Error("The complete clause registry could not be read; no output was written.");
}
const output = `${JSON.stringify({ envelopeVersion: 2, clauses }, null, 2)}\n`;
const destination = fileURLToPath(new URL("../src/diagnostic-codes.json", import.meta.url));
if (options.includes("--check")) {
  if (readFileSync(destination, "utf8") !== output) throw new Error("Editor diagnostic codes differ from the supplied Kin checkout.");
} else {
  writeFileSync(destination, output);
}
console.log(`Verified ${Object.keys(clauses).length} envelope v2 clauses${options.includes("--check") ? "" : "; updated src/diagnostic-codes.json"}.`);
