import fs from "node:fs";
import { execFileSync } from "node:child_process";
import TOML from "@iarna/toml";

// release-policy.mjs — kin-editor's entry point into the cross-repo release
// graph (FIR-1058 / FIR-1066).
//
// It reads release.toml (the release-policy metadata) and enforces it:
//
//   verify        Validate release.toml is well-formed and consistent with
//                 package.json and the code — including that the declared MCP
//                 protocol version matches the initialize handshake in
//                 src/mcp-client.ts, so the compatibility record cannot drift
//                 from what the extension actually speaks. Exit 0/1.
//
//   check-bump    Enforce that a version bump (which cuts a tag and publishes)
//                 is only carried by a real release-impacting change, not by a
//                 dependency/compatibility "consumer bump" alone. Also flags
//                 proof-impacting surface changes for the reviewer. Exit 0/1.
//                 Inputs come from git (--base/--head) or are injected for
//                 tests (--changed-files, --old-version, --new-version).
//
//   proof-impact  Print which proof-impacting surfaces a change touches
//                 (informational; exit 0). Inputs like check-bump.
//
// This tool never publishes and never tags. Publishing stays in
// .github/workflows/release.yml behind the tag + the smoke checks.

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(key.slice(2), "true");
    } else {
      args.set(key.slice(2), next);
      i += 1;
    }
  }
  return args;
}

function readFileOrNull(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Translate a release.toml path glob into a RegExp. Supports `**` (any depth,
// including across `/`) and `*` (a single path segment). Everything else is
// matched literally.
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (".+?()[]{}|^$\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

// Pull the MCP protocol version and announced client version out of the
// initialize handshake in src/mcp-client.ts source (no execution).
function extractMcpHandshake(source) {
  const protocol = source.match(/protocolVersion:\s*"([^"]+)"/);
  const clientInfo = source.match(/clientInfo:\s*\{[\s\S]*?version:\s*"([^"]+)"/);
  return {
    protocolVersion: protocol ? protocol[1] : null,
    clientVersion: clientInfo ? clientInfo[1] : null,
  };
}

function loadPolicy(path) {
  const text = readFileOrNull(path);
  if (text === null) throw new Error(`release policy not found: ${path}`);
  return TOML.parse(text);
}

// ── verify ──────────────────────────────────────────────────────────────────

function verify(opts) {
  const policyPath = opts.get("file") ?? "release.toml";
  const packagePath = opts.get("package") ?? "package.json";
  const mcpClientPath = opts.get("mcp-client") ?? "src/mcp-client.ts";

  const failures = [];
  const warnings = [];

  let policy;
  try {
    policy = loadPolicy(policyPath);
  } catch (error) {
    return { failures: [error.message], warnings };
  }

  if (policy.schema !== 1) failures.push(`unsupported schema: ${policy.schema}`);
  if (!policy.component) failures.push("missing `component`");

  const version = policy.version ?? {};
  if (version.file !== packagePath) {
    failures.push(`version.file is ${JSON.stringify(version.file)}, expected ${JSON.stringify(packagePath)}`);
  }
  if (!version.field) failures.push("missing `version.field`");

  const pkgText = readFileOrNull(packagePath);
  let pkg = null;
  if (pkgText === null) {
    failures.push(`version source not found: ${packagePath}`);
  } else {
    pkg = JSON.parse(pkgText);
    if (version.field && pkg[version.field] === undefined) {
      failures.push(`package field \`${version.field}\` is missing`);
    }
  }

  const publish = policy.publish ?? {};
  if (!Array.isArray(publish.targets) || publish.targets.length === 0) {
    failures.push("publish.targets must be a non-empty array");
  }

  const checks = policy.checks ?? {};
  if (!Array.isArray(checks.pre_publish) || checks.pre_publish.length === 0) {
    failures.push("checks.pre_publish must be a non-empty array");
  }

  // Compatibility record must match the code it claims to describe.
  const compat = policy.compatibility ?? {};
  if (!compat.mcp_protocol) {
    failures.push("compatibility.mcp_protocol is required");
  } else {
    const mcpSource = readFileOrNull(mcpClientPath);
    if (mcpSource === null) {
      failures.push(`cannot source-check compatibility: ${mcpClientPath} not found`);
    } else {
      const { protocolVersion, clientVersion } = extractMcpHandshake(mcpSource);
      if (protocolVersion === null) {
        failures.push(`could not read protocolVersion from ${mcpClientPath}`);
      } else if (protocolVersion !== compat.mcp_protocol) {
        failures.push(
          `compatibility.mcp_protocol (${compat.mcp_protocol}) does not match the initialize handshake in ${mcpClientPath} (${protocolVersion})`
        );
      }
      // The version the extension announces over MCP should match its package
      // version, so the compatibility claim and the artifact stay coherent.
      if (pkg && clientVersion !== null && version.field && clientVersion !== pkg[version.field]) {
        failures.push(
          `MCP clientInfo.version (${clientVersion}) in ${mcpClientPath} does not match package ${version.field} (${pkg[version.field]})`
        );
      }
    }
  }

  const matrix = compat.matrix ?? [];
  if (!Array.isArray(matrix) || matrix.length === 0) {
    failures.push("compatibility.matrix must declare at least one row");
  } else {
    matrix.forEach((row, i) => {
      for (const key of ["extension", "kin_cli", "mcp_protocol"]) {
        if (!row[key]) failures.push(`compatibility.matrix[${i}] missing \`${key}\``);
      }
    });
  }

  const gate = policy.release_gate ?? {};
  for (const key of ["release_impacting", "dependency_only"]) {
    if (!Array.isArray(gate[key]) || gate[key].length === 0) {
      failures.push(`release_gate.${key} must be a non-empty array`);
    }
  }

  // Proof-impacting surfaces must exist so the marker cannot rot.
  const proof = policy.proof_impacting ?? {};
  const surfaces = proof.surfaces ?? [];
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    failures.push("proof_impacting.surfaces must be a non-empty array");
  } else {
    for (const surface of surfaces) {
      if (!fs.existsSync(surface)) {
        failures.push(`proof_impacting surface does not exist: ${surface}`);
      }
    }
  }

  return { failures, warnings };
}

// ── change resolution (git or injected) ──────────────────────────────────────

function resolveChanges(opts) {
  if (opts.has("changed-files")) {
    const changedFiles = String(opts.get("changed-files"))
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    return {
      changedFiles,
      oldVersion: opts.get("old-version") ?? null,
      newVersion: opts.get("new-version") ?? null,
      resolved: true,
    };
  }

  const base = opts.get("base");
  const head = opts.get("head") ?? "HEAD";
  if (!base) {
    return { changedFiles: [], oldVersion: null, newVersion: null, resolved: false };
  }
  const packagePath = opts.get("package") ?? "package.json";
  try {
    const diff = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      encoding: "utf8",
    });
    const changedFiles = diff.split("\n").map((f) => f.trim()).filter(Boolean);
    let oldVersion = null;
    try {
      const basePkg = execFileSync("git", ["show", `${base}:${packagePath}`], { encoding: "utf8" });
      oldVersion = JSON.parse(basePkg).version ?? null;
    } catch {
      oldVersion = null;
    }
    const headPkgText = readFileOrNull(packagePath);
    const newVersion = headPkgText ? JSON.parse(headPkgText).version ?? null : null;
    return { changedFiles, oldVersion, newVersion, resolved: true };
  } catch (error) {
    // Fail open on git-infrastructure problems: this gate must not flake CI on
    // an unresolvable ref. The always-on `verify` job is the hard gate.
    return { changedFiles: [], oldVersion: null, newVersion: null, resolved: false, error: error.message };
  }
}

function classifyBump({ changedFiles, oldVersion, newVersion }, policy) {
  const gate = policy.release_gate ?? {};
  const proof = (policy.proof_impacting ?? {}).surfaces ?? [];
  const releaseImpacting = changedFiles.filter((f) => matchesAny(f, gate.release_impacting ?? []));
  const dependencyOnly = changedFiles.filter((f) => matchesAny(f, gate.dependency_only ?? []));
  const proofImpacting = changedFiles.filter((f) => matchesAny(f, proof));
  const versionChanged =
    oldVersion != null && newVersion != null && oldVersion !== newVersion;

  const failures = [];
  const notes = [];

  if (versionChanged && releaseImpacting.length === 0) {
    failures.push(
      `version moved ${oldVersion} -> ${newVersion} but no release-impacting surface changed. ` +
        `Changes are confined to dependency/compat manifests (${dependencyOnly.join(", ") || "none"}); ` +
        `a dependency-only consumer bump must not auto-release the extension.`
    );
  }
  if (!versionChanged && releaseImpacting.length > 0) {
    notes.push(
      `release-impacting files changed without a version bump — bump the package version before cutting a release.`
    );
  }
  if (proofImpacting.length > 0) {
    notes.push(
      `proof-impacting surfaces changed (${proofImpacting.join(", ")}) — re-validate the first-run matrix and live-MCP proof before release.`
    );
  }

  return { versionChanged, releaseImpacting, dependencyOnly, proofImpacting, failures, notes };
}

// ── subcommands ───────────────────────────────────────────────────────────────

function runVerify(opts) {
  const { failures, warnings } = verify(opts);
  const ok = failures.length === 0;
  if (opts.get("json") === "true") {
    console.log(JSON.stringify({ ok, failures, warnings }, null, 2));
  } else {
    console.log("kin-editor release-policy verify");
    for (const w of warnings) console.log(`  warn: ${w}`);
    for (const f of failures) console.log(`  FAIL: ${f}`);
    console.log(ok ? "  => release.toml is coherent" : "  => release.toml is out of sync");
  }
  process.exitCode = ok ? 0 : 1;
}

function runCheckBump(opts) {
  const policy = loadPolicy(opts.get("file") ?? "release.toml");
  const changes = resolveChanges(opts);
  if (!changes.resolved) {
    console.log("kin-editor release-policy check-bump");
    console.log(`  warn: could not resolve changes${changes.error ? ` (${changes.error})` : ""}; skipping the bump gate`);
    process.exitCode = 0;
    return;
  }
  const result = classifyBump(changes, policy);
  const ok = result.failures.length === 0;
  if (opts.get("json") === "true") {
    console.log(JSON.stringify({ ok, ...result }, null, 2));
  } else {
    console.log("kin-editor release-policy check-bump");
    console.log(`  version changed  : ${result.versionChanged}`);
    console.log(`  release-impacting: ${result.releaseImpacting.join(", ") || "(none)"}`);
    console.log(`  dependency-only  : ${result.dependencyOnly.join(", ") || "(none)"}`);
    for (const n of result.notes) console.log(`  note: ${n}`);
    for (const f of result.failures) console.log(`  FAIL: ${f}`);
    console.log(ok ? "  => bump is policy-clean" : "  => bump violates release policy");
  }
  process.exitCode = ok ? 0 : 1;
}

function runProofImpact(opts) {
  const policy = loadPolicy(opts.get("file") ?? "release.toml");
  const changes = resolveChanges(opts);
  const surfaces = (policy.proof_impacting ?? {}).surfaces ?? [];
  const hit = changes.changedFiles.filter((f) => matchesAny(f, surfaces));
  if (opts.get("json") === "true") {
    console.log(JSON.stringify({ proofImpacting: hit }, null, 2));
  } else {
    console.log("kin-editor release-policy proof-impact");
    if (hit.length === 0) {
      console.log("  no proof-impacting surfaces changed");
    } else {
      for (const f of hit) console.log(`  proof-impacting: ${f}`);
    }
  }
  process.exitCode = 0;
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  switch (sub) {
    case "verify":
      return runVerify(opts);
    case "check-bump":
      return runCheckBump(opts);
    case "proof-impact":
      return runProofImpact(opts);
    default:
      console.error(`usage: release-policy.mjs <verify|check-bump|proof-impact> [flags]`);
      process.exitCode = 2;
  }
}

main();
