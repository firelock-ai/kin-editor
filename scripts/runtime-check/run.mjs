#!/usr/bin/env node
// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

// Real-VS-Code runtime check for the packaged kin-editor extension.
//
// Downloads VS Code through @vscode/test-electron, installs a kin-editor VSIX
// into an empty extensions directory, points it at a given kin binary, opens a
// small fixture repository and drives the shipped behavior from inside the
// extension host: the Graph Browser and Entity Explorer load, Trace Entity, a
// kin:// document opens, a draft is saved and applied where the build ships
// drafts, the result reads back, and both VS Code and the Kin daemon restart
// before a second session reads everything again.
//
// Everything runs under a throwaway HOME, KIN_HOME and VS Code profile, so the
// check never touches the caller's own Kin registry, daemons or editor state.
// Run it with --help for the options. On Linux it needs a display; run it under
// `xvfb-run -a`.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import testElectron from "@vscode/test-electron";

const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath, runTests } = testElectron;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = path.join(HERE, "host");
const EXTENSION_ID = "firelock.kin-editor";
const KIN_REPO = "firelock-ai/kin";
const EDITOR_REPO = "firelock-ai/kin-editor";
const SESSION_TIMEOUT_MS = 8 * 60 * 1000;

const FIXTURE = {
  files: {
    "app.py":
      "from util import scale\n\n\ndef helper(value):\n    return value + 1\n\n\n" +
      "def caller():\n    return helper(41)\n\n\ndef report():\n    return scale(caller())\n",
    "util.py": "def scale(value):\n    return value * 2\n",
  },
  file: "app.py",
  target: "helper",
  names: ["helper", "caller", "report", "scale"],
  traceCallSite: "helper(41)",
  editFrom: "value + 1",
  editTo: "value + 2",
};

const USAGE = `Usage: node run.mjs [options]

Kin binary (one of):
  --kin <path>              a kin binary; kin-daemon must sit beside it
  --kin-release <tag>       a published Kin release, such as v0.7.21
  --kin-archive <path|url>  a release-shaped kin archive (.tar.gz)

Extension (one of):
  --vsix <path|url>         a kin-editor VSIX
  --vsix-release <tag>      a published kin-editor release, or "latest"
  --vsix-from-source <dir>  package the extension from a kin-editor checkout

Other:
  --vscode <version>        VS Code to download: stable (default), insiders or a version
  --out <dir>               where the evidence goes (default runtime-check/.results/<stamp>)
  --cache <dir>             download cache (default runtime-check/.cache)
  --keep                    keep the throwaway work directory
  --help                    show this text`;

function fail(message) {
  console.error(`runtime-check: ${message}`);
  process.exit(2);
}

function options() {
  const { values } = parseArgs({
    options: {
      kin: { type: "string" },
      "kin-release": { type: "string" },
      "kin-archive": { type: "string" },
      vsix: { type: "string" },
      "vsix-release": { type: "string" },
      "vsix-from-source": { type: "string" },
      vscode: { type: "string", default: "stable" },
      out: { type: "string" },
      cache: { type: "string" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const kinSources = ["kin", "kin-release", "kin-archive"].filter((key) => values[key]);
  const vsixSources = ["vsix", "vsix-release", "vsix-from-source"].filter((key) => values[key]);
  if (kinSources.length !== 1) fail(`name exactly one kin binary source\n\n${USAGE}`);
  if (vsixSources.length !== 1) fail(`name exactly one extension source\n\n${USAGE}`);
  return values;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command, args, { cwd, env, allowFailure = false, timeoutMs = 600_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status ?? result.signal}: ${result.error?.message ?? ""}\n${output.stderr.slice(-4000)}`
    );
  }
  return output;
}

// The job token goes only to GitHub's own hosts. A dispatch can name an
// archive or an extension anywhere, and the token must not travel with it.
function githubHeaders(url) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const host = new URL(url).hostname;
  const github = host === "github.com" || host === "api.github.com";
  return token && github ? { authorization: `Bearer ${token}` } : {};
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow", headers: githubHeaders(url) });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, destination);
  return destination;
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", ...githubHeaders(url) },
  });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

function kinAssetName() {
  const system = { darwin: "macos", linux: "linux" }[process.platform];
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  if (!system || !arch) fail(`no published kin build for ${process.platform}-${process.arch}`);
  return `kin-${system}-${arch}`;
}

function findExecutable(root, name) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith(".app")) stack.push(full);
      else if (entry.isFile() && entry.name === name) return full;
    }
  }
  return undefined;
}

async function resolveKin(values, cacheDir, workDir) {
  if (values.kin) {
    const kinPath = path.resolve(values.kin);
    if (!fs.existsSync(kinPath)) fail(`no kin binary at ${kinPath}`);
    const daemonPath = path.join(path.dirname(kinPath), "kin-daemon");
    return describeKin(kinPath, daemonPath, { kind: "path", path: kinPath }, null);
  }
  let archive;
  let source;
  let archiveSha256;
  if (values["kin-release"]) {
    const tag = values["kin-release"];
    const asset = `${kinAssetName()}.tar.gz`;
    const base = `https://github.com/${KIN_REPO}/releases/download/${tag}`;
    archive = path.join(cacheDir, "kin", tag, asset);
    if (!fs.existsSync(archive)) await download(`${base}/${asset}`, archive);
    const published = (await (await fetch(`${base}/${asset}.sha256`, { redirect: "follow" })).text()).trim().split(/\s+/)[0];
    archiveSha256 = sha256File(archive);
    if (published !== archiveSha256) {
      fs.rmSync(archive, { force: true });
      throw new Error(`${asset} hashes to ${archiveSha256}, the release publishes ${published}`);
    }
    source = { kind: "release", repository: KIN_REPO, tag, asset, url: `${base}/${asset}` };
  } else {
    const where = values["kin-archive"];
    if (/^https?:\/\//.test(where)) {
      archive = path.join(cacheDir, "kin", "archives", `${createHash("sha256").update(where).digest("hex").slice(0, 16)}.tar.gz`);
      await download(where, archive);
      source = { kind: "archive-url", url: where };
    } else {
      archive = path.resolve(where);
      source = { kind: "archive-path", path: archive };
    }
    archiveSha256 = sha256File(archive);
  }
  const unpacked = path.join(workDir, "kin");
  fs.mkdirSync(unpacked, { recursive: true });
  run("tar", ["-xzf", archive, "-C", unpacked]);
  const kinPath = findExecutable(unpacked, "kin");
  if (!kinPath) throw new Error(`${archive} holds no kin binary`);
  return describeKin(kinPath, path.join(path.dirname(kinPath), "kin-daemon"), source, archiveSha256);
}

function describeKin(kinPath, daemonPath, source, archiveSha256) {
  const version = run(kinPath, ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir() } }).stdout.trim();
  return {
    path: kinPath,
    daemonPath: fs.existsSync(daemonPath) ? daemonPath : null,
    version,
    sha256: sha256File(kinPath),
    daemonSha256: fs.existsSync(daemonPath) ? sha256File(daemonPath) : null,
    archiveSha256,
    source,
  };
}

function readVsixManifest(vsixPath) {
  const text = run("unzip", ["-p", vsixPath, "extension/package.json"]).stdout;
  const manifest = JSON.parse(text);
  return {
    id: `${manifest.publisher}.${manifest.name}`,
    version: manifest.version,
    commands: (manifest.contributes?.commands ?? []).map((entry) => entry.command),
  };
}

async function resolveVsix(values, cacheDir, env) {
  let vsixPath;
  let source;
  if (values.vsix) {
    if (/^https?:\/\//.test(values.vsix)) {
      vsixPath = path.join(cacheDir, "vsix", `${createHash("sha256").update(values.vsix).digest("hex").slice(0, 16)}.vsix`);
      await download(values.vsix, vsixPath);
      source = { kind: "url", url: values.vsix };
    } else {
      vsixPath = path.resolve(values.vsix);
      source = { kind: "path", path: vsixPath };
    }
  } else if (values["vsix-release"]) {
    const tag = values["vsix-release"];
    const release = await githubJson(
      tag === "latest"
        ? `https://api.github.com/repos/${EDITOR_REPO}/releases/latest`
        : `https://api.github.com/repos/${EDITOR_REPO}/releases/tags/${tag}`
    );
    const asset = release.assets.find((candidate) => candidate.name.endsWith(".vsix"));
    if (!asset) throw new Error(`${EDITOR_REPO} ${release.tag_name} publishes no VSIX`);
    vsixPath = path.join(cacheDir, "vsix", release.tag_name, asset.name);
    if (!fs.existsSync(vsixPath)) await download(asset.browser_download_url, vsixPath);
    const published = asset.digest?.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : null;
    if (published && published !== sha256File(vsixPath)) {
      fs.rmSync(vsixPath, { force: true });
      throw new Error(`${asset.name} does not match the digest the release publishes`);
    }
    source = {
      kind: "release",
      repository: EDITOR_REPO,
      tag: release.tag_name,
      publishedAt: release.published_at,
      url: asset.browser_download_url,
      publishedSha256: published,
    };
  } else {
    const dir = path.resolve(values["vsix-from-source"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const head = run("git", ["-C", dir, "rev-parse", "HEAD"], { allowFailure: true }).stdout.trim() || null;
    const dirty = run("git", ["-C", dir, "status", "--porcelain", "--", "."], { allowFailure: true }).stdout.trim();
    run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, env });
    run("npm", ["run", "compile"], { cwd: dir, env });
    vsixPath = path.join(cacheDir, "vsix", "source", `kin-${manifest.version}-${(head ?? "nohead").slice(0, 12)}.vsix`);
    fs.mkdirSync(path.dirname(vsixPath), { recursive: true });
    run("node", ["./scripts/package-vsix.mjs"], {
      cwd: dir,
      env: { ...env, TAG_NAME: `v${manifest.version}`, VSIX_PATH: vsixPath },
    });
    source = { kind: "source", path: dir, head, dirtyPaths: dirty ? dirty.split("\n") : [] };
  }
  return { path: vsixPath, sha256: sha256File(vsixPath), source, ...readVsixManifest(vsixPath) };
}

async function prepareVsCode(version, cacheDir) {
  const executable = await downloadAndUnzipVSCode({ version, cachePath: path.join(cacheDir, "vscode") });
  const cli = resolveCliPathFromVSCodeExecutablePath(executable);
  const lines = run(cli, ["--version"]).stdout.trim().split("\n");
  return { requested: version, executable, cli, version: lines[0], commit: lines[1] ?? null, arch: lines[2] ?? null };
}

/** A clean environment: nothing Kin, VS Code or Electron leaks in from the caller. */
function cleanEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (/^(KIN_|VSCODE_|ELECTRON_)/.test(key) || key === "_KIN_VFS_LAST_DIR") delete process.env[key];
  }
}

function isolatedEnvironment(workDir, kin) {
  const home = path.join(workDir, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    KIN_HOME: path.join(home, ".kin"),
    KIN_REGISTRY_PATH: path.join(home, "registry.toml"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    PATH: `${path.dirname(kin.path)}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    // No GPU, no model download, no language-server enrichment: the check
    // grades the editor against the graph a plain parse produces.
    KIN_EMBED_BACKEND: "cpu",
    KIN_DAEMON_AUTO_EMBED: "0",
    KIN_DAEMON_DISABLE_LSP: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Kin runtime check",
    GIT_AUTHOR_EMAIL: "runtime-check@kin.invalid",
    GIT_COMMITTER_NAME: "Kin runtime check",
    GIT_COMMITTER_EMAIL: "runtime-check@kin.invalid",
  };
}

/** One MCP tool call through `kin mcp start`, the transport the extension itself uses. */
function mcpCall(kin, cwd, env, tool, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(kin.path, ["mcp", "start", "--tool-profile", "full"], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = Buffer.alloc(0);
    let stderr = "";
    const waiters = new Map();
    const timer = setTimeout(() => finish(new Error(`${tool} did not answer within ${timeoutMs} ms: ${stderr.slice(-2000)}`)), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    }
    child.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const text = buffer.toString("latin1");
        let message;
        if (text.startsWith("Content-Length")) {
          const headerEnd = text.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const length = Number(/Content-Length:\s*(\d+)/i.exec(text.slice(0, headerEnd))[1]);
          if (buffer.length < headerEnd + 4 + length) return;
          message = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
          buffer = buffer.subarray(headerEnd + 4 + length);
        } else {
          const newline = buffer.indexOf(10);
          if (newline < 0) return;
          message = buffer.subarray(0, newline).toString("utf8").trim();
          buffer = buffer.subarray(newline + 1);
          if (!message) continue;
        }
        const parsed = JSON.parse(message);
        const waiter = waiters.get(parsed.id);
        if (waiter) {
          waiters.delete(parsed.id);
          waiter(parsed);
        }
      }
    });
    const send = (payload) => {
      const text = JSON.stringify(payload);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    };
    const request = (id, method, params) =>
      new Promise((answer) => {
        waiters.set(id, answer);
        send({ jsonrpc: "2.0", id, method, params });
      });
    (async () => {
      const initialized = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "kin-editor-runtime-check", version: "1" },
      });
      if (initialized.error) throw new Error(`initialize: ${initialized.error.message}`);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const answer = await request(2, "tools/call", { name: tool, arguments: args });
      if (answer.error) throw new Error(`${tool}: ${answer.error.message}`);
      const text = answer.result?.content?.[0]?.text ?? "";
      if (answer.result?.isError) throw new Error(`${tool}: ${text.slice(0, 2000)}`);
      finish(undefined, { server: initialized.result?.serverInfo ?? null, payload: JSON.parse(text) });
    })().catch((error) => finish(error));
  });
}

async function readSource(kin, repo, env) {
  const { server, payload } = await mcpCall(kin, repo, env, "get_entity_source", { entity_id: FIXTURE.target });
  return { server, id: payload.id, body: payload.body, file: payload.file_path, runtime: payload._kin?.runtime ?? null };
}

function kinDaemon(kin, repo, env, args) {
  return run(kin.path, ["daemon", ...args], { cwd: repo, env: { ...process.env, ...env }, allowFailure: true });
}

/** Processes whose command line names the throwaway work directory are ours. */
function ownedProcesses(workDir) {
  const listing = run("ps", ["-Ao", "pid=,args="], { allowFailure: true }).stdout;
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(workDir))
    .map((line) => ({ pid: Number(line.split(/\s+/, 1)[0]), args: line.slice(line.indexOf(" ") + 1) }))
    .filter((entry) => entry.pid !== process.pid);
}

async function stopOwned(workDir) {
  const signalled = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const live = ownedProcesses(workDir);
    if (live.length === 0) break;
    for (const entry of live) {
      try {
        process.kill(entry.pid, signal);
        signalled.push({ ...entry, signal });
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return signalled;
}

function writeSettings(profileDir, kin) {
  const user = path.join(profileDir, "User");
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(
    path.join(user, "settings.json"),
    JSON.stringify(
      {
        "kin.binaryPath": kin.path,
        "kin.mcpEnabled": true,
        "kin.entityViewer": true,
        "kin.queryTimeoutMs": 30000,
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "window.restoreWindows": "none",
        "security.workspace.trust.enabled": false,
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoUpdate": false,
        "extensions.autoCheckUpdates": false,
        "git.enabled": false,
      },
      null,
      2
    )
  );
}

async function session(phase, context) {
  const phaseDir = path.join(context.outDir, `session-${phase}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  const inputPath = path.join(phaseDir, "input.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        phase,
        phaseDir,
        repo: context.repo,
        extensionsDir: context.extensionsDir,
        expectedExtensionVersion: context.vsix.version,
        fixture: FIXTURE,
        source: context.source,
        previous: context.previous ?? null,
      },
      null,
      2
    )
  );
  const log = fs.createWriteStream(path.join(phaseDir, "vscode-output.log"));
  const launchArgs = [
    context.repo,
    `--user-data-dir=${context.profileDir}`,
    `--extensions-dir=${context.extensionsDir}`,
    "--disable-gpu",
    "--use-inmemory-secretstorage",
    "--new-window",
    ...(process.platform === "linux" ? ["--password-store=basic"] : []),
  ];
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    for (const entry of ownedProcesses(context.profileDir)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, SESSION_TIMEOUT_MS);
  let exit;
  try {
    exit = await runTests({
      vscodeExecutablePath: context.vscode.executable,
      extensionDevelopmentPath: HOST_DIR,
      extensionTestsPath: path.join(HOST_DIR, "session.cjs"),
      launchArgs,
      extensionTestsEnv: { ...context.env, KIN_RUNTIME_CHECK_INPUT: inputPath },
      stdout: log,
      stderr: log,
    });
  } catch (error) {
    exit = error.code ?? error.message;
  } finally {
    clearTimeout(watchdog);
    log.end();
  }
  const resultPath = path.join(phaseDir, "host-result.json");
  const host = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : null;
  const logs = path.join(context.profileDir, "logs");
  if (fs.existsSync(logs)) fs.cpSync(logs, path.join(phaseDir, "vscode-logs"), { recursive: true });
  return { phase, exit, watchdogFired, host };
}

function addStep(result, name, status, detail) {
  result.steps.push({ name, status, detail: detail ?? null });
}

async function orchestrate(values) {
  cleanEnvironment();
  const cacheDir = path.resolve(values.cache ?? path.join(HERE, ".cache"));
  const outDir = path.resolve(values.out ?? path.join(HERE, ".results", `${stamp()}-${process.platform}-${process.arch}`));
  fs.mkdirSync(outDir, { recursive: true });
  // macOS keeps Unix socket paths under 104 bytes, and VS Code puts its IPC
  // socket in the profile, so the throwaway tree lives in a short /tmp path.
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "kinrt-")));
  const result = {
    schema: "kin-editor-runtime-check/v1",
    startedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      node: process.version,
      display: process.env.DISPLAY ?? null,
    },
    vscode: null,
    extension: null,
    kin: null,
    steps: [],
    sessions: [],
    readbacks: {},
    cleanup: null,
    limits: [
      "Language-server enrichment, embeddings and model downloads are off (KIN_DAEMON_DISABLE_LSP=1, KIN_EMBED_BACKEND=cpu, KIN_DAEMON_AUTO_EMBED=0); the graph is what a plain parse produces.",
      "VS Code runs from a fresh profile with --use-inmemory-secretstorage; OS keychain integration is not graded.",
      "The fixture is a two-file Python repository, not a user repository.",
      "A daemon stopped with `kin daemon stop` restarts cold; that is not power-loss durability.",
    ],
  };
  const save = () => {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  };
  console.log(`runtime-check: evidence in ${outDir}`);
  let env;
  let kin;
  const repo = path.join(workDir, "repo");
  try {
    kin = await resolveKin(values, cacheDir, workDir);
    result.kin = kin;
    env = isolatedEnvironment(workDir, kin);
    const vsix = await resolveVsix(values, cacheDir, { ...process.env });
    result.extension = { ...vsix };
    if (vsix.id !== EXTENSION_ID) throw new Error(`the VSIX is ${vsix.id}, not ${EXTENSION_ID}`);
    const vscode = await prepareVsCode(values.vscode, cacheDir);
    result.vscode = vscode;
    addStep(result, "vscode_downloaded", "passed", `${vscode.version} ${vscode.commit ?? ""} ${vscode.arch ?? ""}`.trim());

    const profileDir = path.join(workDir, "profile");
    const extensionsDir = path.join(workDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });
    const vscodeEnv = { ...process.env, ...env };
    run(vscode.cli, [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${profileDir}`, "--install-extension", vsix.path, "--force"], { env: vscodeEnv });
    const listed = run(vscode.cli, [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${profileDir}`, "--list-extensions", "--show-versions"], { env: vscodeEnv }).stdout;
    if (!listed.split("\n").some((line) => line.trim().toLowerCase() === `${EXTENSION_ID}@${vsix.version}`.toLowerCase())) {
      throw new Error(`VS Code lists ${JSON.stringify(listed.trim())} after installing ${vsix.path}`);
    }
    addStep(result, "vsix_installed", "passed", `${EXTENSION_ID}@${vsix.version}`);

    fs.mkdirSync(repo, { recursive: true });
    for (const [name, body] of Object.entries(FIXTURE.files)) fs.writeFileSync(path.join(repo, name), body);
    const gitEnv = { ...process.env, ...env };
    run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
    run("git", ["add", "-A"], { cwd: repo, env: gitEnv });
    run("git", ["commit", "-q", "-m", "Runtime check fixture"], { cwd: repo, env: gitEnv });
    const init = run(kin.path, ["init", "--no-enrich", "--json"], { cwd: repo, env: gitEnv });
    fs.writeFileSync(path.join(outDir, "kin-init.json"), init.stdout);
    const source = await readSource(kin, repo, env);
    result.readbacks.beforeEditor = source;
    addStep(result, "fixture_admitted", "passed", `${FIXTURE.target} is ${source.id} in ${source.file}`);

    writeSettings(profileDir, kin);
    const context = { outDir, repo, profileDir, extensionsDir, vsix, vscode, env, source };

    const first = await session("first", context);
    result.sessions.push(first);
    const afterFirst = await readSource(kin, repo, env);
    result.readbacks.afterFirstSession = afterFirst;
    const edited = first.host?.state?.editedBody ?? null;
    if (edited !== null) {
      const matches = afterFirst.body.trimEnd() === edited.trimEnd();
      addStep(result, "daemon_readback_after_apply", matches ? "passed" : "failed", matches ? afterFirst.body : `the daemon holds ${JSON.stringify(afterFirst.body)}`);
    }

    const stopped = kinDaemon(kin, repo, env, ["stop"]);
    const status = kinDaemon(kin, repo, env, ["status"]);
    const running = /worker daemon running/.test(status.stdout);
    addStep(result, "daemon_stopped_for_restart", running ? "failed" : "passed", `${stopped.stdout.trim()} ${running ? status.stdout.trim() : ""}`.trim());

    const restart = await session("restart", {
      ...context,
      previous: {
        expectedBody: afterFirst.body,
        draftUri: first.host?.state?.draftUri ?? null,
        editedBody: edited,
      },
    });
    result.sessions.push(restart);
    const afterRestart = await readSource(kin, repo, env);
    result.readbacks.afterRestart = afterRestart;
    const durable = afterRestart.body === afterFirst.body && afterRestart.id === afterFirst.id;
    addStep(result, "daemon_readback_after_restart", durable ? "passed" : "failed", durable ? afterRestart.body : `before ${JSON.stringify(afterFirst)}, after ${JSON.stringify(afterRestart)}`);
    fs.writeFileSync(path.join(outDir, `fixture-${FIXTURE.file}`), fs.readFileSync(path.join(repo, FIXTURE.file)));
  } catch (error) {
    addStep(result, "harness", "failed", error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    const cleanup = { daemonStop: null, signalled: [], removed: false };
    if (kin && env && fs.existsSync(repo)) {
      // The repo's own daemon first: a daemon an MCP client started can be
      // registered without its home, and `--all` then skips it and keeps the
      // supervisor alive for it.
      cleanup.daemonStop = [
        kinDaemon(kin, repo, env, ["stop"]).stdout.trim(),
        kinDaemon(kin, repo, env, ["stop", "--all"]).stdout.trim(),
      ];
    }
    cleanup.signalled = await stopOwned(workDir);
    cleanup.remaining = ownedProcesses(workDir);
    if (!values.keep && cleanup.remaining.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      cleanup.removed = true;
    } else {
      cleanup.workDir = workDir;
    }
    result.cleanup = cleanup;
    grade(result);
    save();
    fs.writeFileSync(path.join(outDir, "summary.md"), summary(result));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result));
  }
  console.log(summary(result));
  return result.passed ? 0 : 1;
}

function grade(result) {
  const steps = [...result.steps];
  for (const entry of result.sessions) {
    if (entry.exit !== 0) {
      steps.push({ name: `session_${entry.phase}_exit`, status: "failed", detail: `VS Code exited ${entry.exit}${entry.watchdogFired ? " after the watchdog fired" : ""}` });
    }
    if (!entry.host?.finished) {
      steps.push({ name: `session_${entry.phase}_host`, status: "failed", detail: "the extension host never finished the session" });
    }
    for (const step of entry.host?.steps ?? []) {
      steps.push({ name: `${entry.phase}.${step.name}`, status: step.status, detail: step.detail ?? step.error ?? null });
    }
  }
  if (result.cleanup?.remaining?.length) {
    steps.push({ name: "cleanup", status: "failed", detail: `processes outlived the run: ${JSON.stringify(result.cleanup.remaining)}` });
  }
  result.graded = steps;
  result.passed = steps.length > 0 && steps.every((step) => step.status !== "failed" && step.status !== "running");
}

function summary(result) {
  const vsExt = result.extension;
  const source = vsExt?.source ?? {};
  const kinSource = result.kin?.source ?? {};
  const lines = [
    `## kin-editor runtime check: ${result.passed ? "passed" : "FAILED"}`,
    "",
    `- Host: ${result.host.platform}-${result.host.arch} (${result.host.hostname}, ${result.host.release})`,
    `- VS Code: ${result.vscode ? `${result.vscode.version} (${result.vscode.commit ?? "?"}, ${result.vscode.arch ?? "?"})` : "not prepared"}`,
    `- Extension: ${vsExt ? `${vsExt.id}@${vsExt.version} from ${source.kind === "release" ? `${source.repository} ${source.tag}` : source.kind === "source" ? `source ${source.head ?? "?"}${source.dirtyPaths?.length ? " (dirty)" : ""}` : source.url ?? source.path}, sha256 ${vsExt.sha256}` : "not prepared"}`,
    `- Kin: ${result.kin ? `${result.kin.version} from ${kinSource.kind === "release" ? `${kinSource.repository} ${kinSource.tag} ${kinSource.asset}` : kinSource.url ?? kinSource.path}, kin sha256 ${result.kin.sha256}` : "not prepared"}`,
    "",
    "| Step | Result | Detail |",
    "| --- | --- | --- |",
  ];
  for (const step of result.graded ?? []) {
    const detail = typeof step.detail === "string" ? step.detail : JSON.stringify(step.detail ?? "");
    lines.push(`| ${step.name} | ${step.status} | ${detail.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 300)} |`);
  }
  lines.push("", "Limits:", ...result.limits.map((limit) => `- ${limit}`), "");
  return lines.join("\n");
}

process.exitCode = await orchestrate(options());
