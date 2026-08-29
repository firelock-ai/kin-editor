// Copyright 2026 Firelock LLC
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";
import {
  HealthCheck,
  HealthReport,
  HealthStatusValue,
  composeReadiness,
  hasFixableChecks,
  resolveKinBinary,
  runSetupStatus,
} from "./setup-health";
import { describeError } from "./accessibility";
import { log, logError } from "./logger";

interface WebviewMessage {
  command: string;
  text?: string;
}

const STATUS_GLYPH: Record<HealthStatusValue, string> = {
  healthy: "✓",
  missing: "✗",
  misconfigured: "✗",
  stale: "!",
  // Work still in flight, not a fault. It reads as motion rather than as a
  // cross, because both of these normalized to `missing` before and a fresh
  // install's model download rendered as a red Missing row.
  pending: "…",
  degraded: "!",
  unsupported: "→",
  // A status word this extension does not know. It is not a cross, because
  // "we cannot read this" and "this is broken" are different claims and only
  // one of them is true here.
  unknown: "?",
};

const STATUS_LABEL: Record<HealthStatusValue, string> = {
  healthy: "OK",
  missing: "Missing",
  misconfigured: "Misconfigured",
  stale: "Stale",
  pending: "Working",
  degraded: "Degraded",
  unsupported: "Not supported",
  unknown: "Unrecognized",
};

let activePanel: vscode.WebviewPanel | undefined;

/**
 * Open (or reveal) the "Kin: Setup Workspace" first-run panel. The panel runs
 * the real CLI health engine via `kin setup status --json` and renders the
 * resulting checklist with fix actions. No state shown here is fabricated.
 */
export async function showSetupWorkspace(
  context: vscode.ExtensionContext,
  cwd: string | undefined
): Promise<void> {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Active);
    await refresh(activePanel, cwd);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "kinSetupWorkspace",
    "Kin: Setup Workspace",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel = panel;
  context.subscriptions.push(panel);

  panel.onDidDispose(
    () => {
      if (activePanel === panel) {
        activePanel = undefined;
      }
    },
    null,
    context.subscriptions
  );

  panel.webview.onDidReceiveMessage(
    (message: WebviewMessage) => handleMessage(panel, cwd, message),
    undefined,
    context.subscriptions
  );

  await refresh(panel, cwd);
}

async function refresh(
  panel: vscode.WebviewPanel,
  cwd: string | undefined
): Promise<void> {
  panel.webview.html = loadingHtml(panel.webview);
  try {
    const report = await runSetupStatus(cwd);
    log(
      `Setup Workspace: health report: ${report.checks.length} checks, verdict=${report.verdict} (source ${report.verdictSource.kind})`
    );
    panel.webview.html = reportHtml(panel.webview, report);
  } catch (err) {
    logError("Setup Workspace: kin setup status failed", err);
    panel.webview.html = errorHtml(panel.webview, describeError(err));
  }
}

async function handleMessage(
  panel: vscode.WebviewPanel,
  cwd: string | undefined,
  message: WebviewMessage
): Promise<void> {
  switch (message.command) {
    case "refresh":
      await refresh(panel, cwd);
      return;
    case "doctorFix":
      runDoctorFix(cwd);
      return;
    case "runCommand":
      if (message.text) {
        runInTerminal(message.text, cwd);
      }
      return;
    case "copy":
      if (message.text) {
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage("Copied fix command to clipboard.");
      }
      return;
    case "search":
      await vscode.commands.executeCommand("kin.search");
      return;
    case "init":
      await vscode.commands.executeCommand("kin.init");
      return;
    default:
      return;
  }
}

function runDoctorFix(cwd: string | undefined): void {
  const binary = resolveKinBinary();
  const terminal = vscode.window.createTerminal({
    name: "Kin Doctor",
    cwd,
  });
  terminal.show();
  terminal.sendText(`${quoteArg(binary)} doctor --fix`);
}

function runInTerminal(commandLine: string, cwd: string | undefined): void {
  const terminal = vscode.window.createTerminal({
    name: "Kin Setup",
    cwd,
  });
  terminal.show();
  terminal.sendText(commandLine);
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function nonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function pageShell(webview: vscode.Webview, body: string, scriptNonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${scriptNonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${styles()}</style>
</head>
<body>
${body}
<script nonce="${scriptNonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-command]');
  if (!target) { return; }
  const command = target.getAttribute('data-command');
  const text = target.getAttribute('data-text') || undefined;
  vscode.postMessage({ command, text });
});
</script>
</body>
</html>`;
}

function styles(): string {
  return `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
h1 { font-size: 1.4em; margin: 0 0 4px; }
.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
.banner { padding: 10px 12px; border-radius: 4px; margin-bottom: 16px; }
.banner.ok { background: var(--vscode-inputValidation-infoBackground, rgba(100,180,100,0.12)); border: 1px solid var(--vscode-charts-green, #4caf50); }
.banner.warn { background: var(--vscode-inputValidation-warningBackground, rgba(200,160,40,0.12)); border: 1px solid var(--vscode-charts-yellow, #d8a000); }
.banner.bad { background: var(--vscode-inputValidation-errorBackground, rgba(220,80,80,0.12)); border: 1px solid var(--vscode-charts-red, #f14c4c); }
.banner .advice { margin-top: 6px; }
.banner .note { margin: 6px 0 0; color: var(--vscode-descriptionForeground); font-style: italic; }
.check { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3)); border-radius: 4px; padding: 10px 12px; margin-bottom: 10px; }
.check-head { display: flex; align-items: baseline; gap: 8px; }
.glyph { font-weight: bold; width: 1.2em; text-align: center; }
.glyph.healthy { color: var(--vscode-charts-green, #4caf50); }
.glyph.missing, .glyph.misconfigured { color: var(--vscode-charts-red, #f14c4c); }
.glyph.stale, .glyph.degraded { color: var(--vscode-charts-yellow, #d8a000); }
.glyph.pending { color: var(--vscode-charts-blue, #3794ff); }
.glyph.unsupported { color: var(--vscode-charts-blue, #3794ff); }
.glyph.unknown { color: var(--vscode-descriptionForeground); }
.check-label { font-weight: 600; }
.check-status { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: auto; }
.detail { margin: 4px 0 0 1.6em; color: var(--vscode-foreground); }
.note { margin: 6px 0 0 1.6em; color: var(--vscode-descriptionForeground); font-style: italic; }
.fix { margin: 8px 0 0 1.6em; }
.fix code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 2px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); }
.actions { margin: 8px 0 0 1.6em; display: flex; gap: 8px; flex-wrap: wrap; }
button { font-family: inherit; font-size: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 5px 12px; border-radius: 3px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.toolbar { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
.error { color: var(--vscode-errorForeground); }
`;
}

function statusLine(check: HealthCheck): string {
  const glyph = STATUS_GLYPH[check.status];
  const statusText = STATUS_LABEL[check.status];
  const parts = [
    `<div class="check-head">`,
    `<span class="glyph ${check.status}">${glyph}</span>`,
    `<span class="check-label">${escapeHtml(check.label)}</span>`,
    `<span class="check-status">${escapeHtml(statusText)}</span>`,
    `</div>`,
  ];
  if (check.detail) {
    parts.push(`<div class="detail">${escapeHtml(check.detail)}</div>`);
  }
  if (check.status === "unknown") {
    // Say the word the CLI wrote. Rendering "Unrecognized" without it tells
    // the user less than the CLI said, and leaves them nothing to report.
    parts.push(
      `<div class="note">This kin CLI reported the status "${escapeHtml(check.rawStatus ?? "")}", which this extension does not recognize. Update the Kin extension.</div>`
    );
  }
  if (check.platform_note) {
    parts.push(`<div class="note">Platform note: ${escapeHtml(check.platform_note)}</div>`);
  }
  if (check.status !== "healthy" && check.manual_fix) {
    parts.push(
      `<div class="fix">Fix: <code>${escapeHtml(check.manual_fix)}</code></div>`
    );
    parts.push(
      `<div class="actions">` +
        actionButtons(check) +
        `</div>`
    );
  }
  return `<div class="check">${parts.join("")}</div>`;
}

function actionButtons(check: HealthCheck): string {
  const buttons: string[] = [];
  if (check.manual_fix) {
    const isShellCommand = looksRunnable(check.manual_fix);
    if (isShellCommand) {
      buttons.push(
        `<button data-command="runCommand" data-text="${escapeAttr(check.manual_fix)}">Run in terminal</button>`
      );
    }
    buttons.push(
      `<button class="secondary" data-command="copy" data-text="${escapeAttr(check.manual_fix)}">Copy command</button>`
    );
  }
  return buttons.join("");
}

/**
 * Heuristic: only offer "Run in terminal" for manual fixes that read like a
 * concrete shell command. Prose guidance (e.g. "install the kin-editor VS Code
 * extension (see the kin-editor README)") gets copy-only.
 */
function looksRunnable(manualFix: string): boolean {
  const trimmed = manualFix.trim();
  if (/^(run\s+`|run\s+kin\b)/i.test(trimmed)) {
    return true;
  }
  return /^(kin|cargo|rm|npm|npx|git)\b/.test(trimmed);
}

/**
 * Render the readiness banner from the report's verdict.
 *
 * Keyed on {@link composeReadiness} rather than on `report.healthy`, because
 * that boolean collapses "still warming up" and "broken" into one false, and a
 * banner reading it renders a fresh install's model download as a failure.
 */
export function bannerHtml(report: HealthReport): string {
  const line = composeReadiness(report);
  const parts = [
    `<div class="banner ${line.tone}">`,
    `<div>${escapeHtml(line.headline)}</div>`,
    `<div class="advice">${escapeHtml(line.advice)}</div>`,
  ];
  if (line.disagreementNote) {
    parts.push(`<p class="note">${escapeHtml(line.disagreementNote)}</p>`);
  }
  if (line.sourceNote) {
    parts.push(`<p class="note">${escapeHtml(line.sourceNote)}</p>`);
  }
  parts.push(`</div>`);
  return parts.join("");
}

function reportHtml(webview: vscode.Webview, report: HealthReport): string {
  const scriptNonce = nonce();
  const banner = bannerHtml(report);

  const toolbarButtons: string[] = [];
  toolbarButtons.push(
    `<button data-command="refresh">Re-check</button>`
  );
  if (hasFixableChecks(report)) {
    toolbarButtons.push(
      `<button data-command="doctorFix">Run kin doctor --fix</button>`
    );
  }
  if (report.checks.some((c) => c.id === "repo_init" && c.status !== "healthy")) {
    toolbarButtons.push(
      `<button class="secondary" data-command="init">Initialize Repository</button>`
    );
  }
  // Offered on anything that is not failing, which is exactly the set the old
  // `report.healthy` gate offered it to. Narrowing it to `ready` would have
  // hidden a working search from every warming install, which is a regression
  // this change would have shipped in the name of fixing the banner.
  if (report.verdict !== "failing") {
    toolbarButtons.push(
      `<button class="secondary" data-command="search">Try a semantic search</button>`
    );
  }

  const checks = report.checks.map(statusLine).join("");

  const body = `
<h1>Set up Kin in this workspace</h1>
<p class="subtitle">Platform: ${escapeHtml(report.platform)}. Every status below comes from <code>kin setup status</code>.</p>
${banner}
<div class="toolbar">${toolbarButtons.join("")}</div>
${checks}
`;
  return pageShell(webview, body, scriptNonce);
}

function loadingHtml(webview: vscode.Webview): string {
  const scriptNonce = nonce();
  const body = `<h1>Set up Kin in this workspace</h1><p class="subtitle">Running <code>kin setup status</code>…</p>`;
  return pageShell(webview, body, scriptNonce);
}

function errorHtml(webview: vscode.Webview, detail: string): string {
  const scriptNonce = nonce();
  const body = `
<h1>Set up Kin in this workspace</h1>
<div class="banner warn">Could not run <code>kin setup status</code>.</div>
<p class="error">${escapeHtml(detail)}</p>
<p class="subtitle">Make sure the <code>kin</code> binary is installed and on your PATH, or set <code>kin.binaryPath</code> in settings.</p>
<div class="toolbar"><button data-command="refresh">Retry</button></div>
`;
  return pageShell(webview, body, scriptNonce);
}
