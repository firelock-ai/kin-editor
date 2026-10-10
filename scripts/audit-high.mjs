#!/usr/bin/env node
// Runs `npm audit` and fails on any high/critical advisory, except the
// explicitly allowlisted ones below. Each exception must be a single advisory
// with a reason; transitive "via" entries are judged by their root advisory.
import { execFileSync } from "node:child_process";

// GHSA-vfj7-8cjw-p6xm (braces): reached only through dev-only packaging
// tooling (@vscode/vsce / ovsx -> secretlint -> globby -> fast-glob ->
// micromatch -> braces). It is not shipped in the VSIX runtime, and no patched
// braces release exists (3.0.3 is the latest), so an npm `overrides` entry
// cannot fix it. Remove this entry as soon as a fixed braces is published.
const ALLOWED = new Set(["GHSA-vfj7-8cjw-p6xm"]);
const BLOCKING = new Set(["high", "critical"]);

let out;
try {
  out = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 });
} catch (err) {
  out = err.stdout; // npm audit exits non-zero when it finds anything
  if (!out) throw err;
}
const report = JSON.parse(out);
if (report.error) {
  console.error("npm audit failed:", JSON.stringify(report.error));
  process.exit(1);
}

const blocking = new Map();
const allowed = new Set();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
    const id = String(via.url ?? "").split("/").pop();
    if (ALLOWED.has(id)) allowed.add(`${id} (${via.name})`);
    else blocking.set(`${id || via.source} (${via.name})`, via.title);
  }
}
for (const a of allowed) console.log(`allowlisted: ${a}`);
if (blocking.size) {
  for (const [k, t] of blocking) console.error(`BLOCKING high/critical: ${k} ${t}`);
  process.exit(1);
}
console.log("npm audit: no high/critical advisories outside the allowlist");
